//! Discord OAuth2 login using the Authorization Code + PKCE flow.
//!
//! This app is a public desktop client with source published on GitHub, so it
//! cannot safely hold a Discord client secret (anyone could extract it from
//! the binary or the repo). PKCE exists exactly for this case: the client
//! proves it initiated the flow via a one-time-use code_verifier instead of
//! a long-lived secret, so no secret needs to ship with the app at all.
//!
//! Flow:
//! 1. Generate a random `code_verifier` and its SHA-256 `code_challenge`.
//! 2. Start a short-lived local HTTP server on 127.0.0.1 to catch the redirect.
//! 3. Open the user's default browser to Discord's authorize URL.
//! 4. Wait for Discord to redirect back to our local server with `?code=...`.
//! 5. Exchange the code (+ code_verifier) for an access token — no secret needed.
//! 6. Fetch the user's Discord profile (username, avatar) with that token.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const DISCORD_CLIENT_ID: &str = "1538407141373902909";
const REDIRECT_PORT: u16 = 31415;
const AUTH_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordAccount {
    pub id: String,
    pub username: String,
    pub global_name: Option<String>,
    pub avatar_url: Option<String>,
}

fn redirect_uri() -> String {
    format!("http://127.0.0.1:{REDIRECT_PORT}/callback")
}

/// URL-safe base64 without padding, as required by the PKCE spec (RFC 7636).
fn b64url(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    URL_SAFE_NO_PAD.encode(bytes)
}

fn generate_pkce_pair() -> (String, String) {
    let mut verifier_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = b64url(&verifier_bytes);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = b64url(&hasher.finalize());

    (verifier, challenge)
}

fn generate_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    b64url(&bytes)
}

/// Runs the full login flow end-to-end. Blocking — call this from a
/// spawned/async Tauri command, not the UI thread.
pub async fn login() -> Result<DiscordAccount, String> {
    let (code_verifier, code_challenge) = generate_pkce_pair();
    let state = generate_state();

    let auth_url = format!(
        "https://discord.com/oauth2/authorize?\
         client_id={client_id}&response_type=code&redirect_uri={redirect}&\
         scope=identify&state={state}&code_challenge={challenge}&code_challenge_method=S256",
        client_id = DISCORD_CLIENT_ID,
        redirect = urlencoding::encode(&redirect_uri()),
        state = state,
        challenge = code_challenge,
    );

    // tiny_http's recv_timeout() is a blocking call, and opening the browser
    // + waiting up to AUTH_TIMEOUT_SECS for the redirect would otherwise
    // stall Tauri's async runtime for the whole app. Run the blocking parts
    // on a dedicated thread instead.
    let state_for_thread = state.clone();
    let code = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let server = tiny_http::Server::http(format!("127.0.0.1:{REDIRECT_PORT}"))
            .map_err(|e| format!("Could not start local callback server: {e}"))?;

        open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;

        wait_for_callback(&server, &state_for_thread)
    })
    .await
    .map_err(|e| format!("Login task failed: {e}"))??;

    let access_token = exchange_code(&code, &code_verifier).await?;
    fetch_user(&access_token).await
}

/// Blocks (with a timeout) until the browser redirects back with `?code=...`,
/// verifying `state` matches to guard against a stray/forged request hitting
/// our local port. Responds with a small HTML page so the browser tab shows
/// something sensible instead of hanging blank.
fn wait_for_callback(server: &tiny_http::Server, expected_state: &str) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(AUTH_TIMEOUT_SECS);

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Login timed out — no response from Discord.".into());
        }

        let request = match server.recv_timeout(remaining) {
            Ok(Some(req)) => req,
            Ok(None) => return Err("Login timed out — no response from Discord.".into()),
            Err(e) => return Err(format!("Local server error: {e}")),
        };

        let url = request.url().to_string();
        let query = url.splitn(2, '?').nth(1).unwrap_or("");
        let params = parse_query(query);

        let is_callback = url.starts_with("/callback");

        if is_callback {
            let respond_html = |body: &str| {
                let header = tiny_http::Header::from_bytes(
                    &b"Content-Type"[..],
                    &b"text/html; charset=utf-8"[..],
                )
                .unwrap();
                let _ = request.respond(tiny_http::Response::from_string(body).with_header(header));
            };

            if let Some(err) = params.get("error") {
                respond_html("<html><body><p>Login was cancelled. You can close this tab.</p></body></html>");
                return Err(format!("Discord returned an error: {err}"));
            }

            let returned_state = params.get("state").cloned().unwrap_or_default();
            if returned_state != expected_state {
                respond_html("<html><body><p>Login failed (state mismatch). You can close this tab.</p></body></html>");
                return Err("State mismatch — possible spoofed callback, aborting.".into());
            }

            match params.get("code") {
                Some(code) => {
                    respond_html("<html><body><p>Signed in — you can close this tab and return to Ender Client.</p></body></html>");
                    return Ok(code.clone());
                }
                None => {
                    respond_html("<html><body><p>Login failed (no code). You can close this tab.</p></body></html>");
                    return Err("Callback had no ?code= parameter.".into());
                }
            }
        } else {
            // Anything else hitting this port (e.g. a browser favicon probe)
            // gets a harmless 404 so it doesn't consume our one expected request.
            let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
        }
    }
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((
                urlencoding::decode(key).ok()?.into_owned(),
                urlencoding::decode(value).ok()?.into_owned(),
            ))
        })
        .collect()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
}

async fn exchange_code(code: &str, code_verifier: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let redirect = redirect_uri();

    let params = [
        ("client_id", DISCORD_CLIENT_ID),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect.as_str()),
        ("code_verifier", code_verifier),
    ];

    let resp = client
        .post("https://discord.com/api/oauth2/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({status}): {body}"));
    }

    let token: TokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("Could not parse token response: {e}"))?;

    Ok(token.access_token)
}

#[derive(Deserialize)]
struct DiscordUserResponse {
    id: String,
    username: String,
    global_name: Option<String>,
    avatar: Option<String>,
}

async fn fetch_user(access_token: &str) -> Result<DiscordAccount, String> {
    let client = reqwest::Client::new();

    let resp = client
        .get("https://discord.com/api/users/@me")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Profile request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Profile request failed ({status}): {body}"));
    }

    let user: DiscordUserResponse = resp
        .json()
        .await
        .map_err(|e| format!("Could not parse profile response: {e}"))?;

    let avatar_url = user.avatar.as_ref().map(|hash| {
        let ext = if hash.starts_with("a_") { "gif" } else { "png" };
        format!("https://cdn.discordapp.com/avatars/{}/{}.{}?size=128", user.id, hash, ext)
    });

    Ok(DiscordAccount {
        id: user.id,
        username: user.username,
        global_name: user.global_name,
        avatar_url,
    })
}
