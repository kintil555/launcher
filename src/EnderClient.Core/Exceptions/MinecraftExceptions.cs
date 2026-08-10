namespace EnderClient.Core.Exceptions;

public sealed class MinecraftNotInstalledException : Exception
{
    public MinecraftNotInstalledException()
        : base("Minecraft Bedrock (UWP) was not found on this system.") { }
}

public sealed class MinecraftLaunchTimeoutException : Exception
{
    public MinecraftLaunchTimeoutException()
        : base("Minecraft did not start within the expected time.") { }
}

public sealed class InjectionFailedException : Exception
{
    public InjectionFailedException(string message) : base(message) { }
}
