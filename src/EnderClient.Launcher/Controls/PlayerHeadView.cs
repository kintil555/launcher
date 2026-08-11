using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using EnderClient.Core.Rendering;

namespace EnderClient.Launcher.Controls;

/// <summary>
/// Renders the Minecraft player head as a rotatable pseudo-3D cube, textured from a skin PNG.
/// No 3D engine involved: vertices are projected with a hand-rolled rotation, and triangles are
/// depth-sorted back-to-front (painter's algorithm). All 12 triangles are drawn in that order —
/// no backface culling — because the source mesh's per-face winding isn't uniform (some faces
/// wind clockwise, some counter-clockwise, depending on how Blockbench emitted them), so a
/// screen-space cross-product test culls the wrong faces. Depth order alone is correct and
/// sufficient for a convex, fully opaque cube: the far faces get correctly painted over.
/// </summary>
public sealed class PlayerHeadView : Control
{
    public static readonly StyledProperty<Bitmap?> SkinProperty =
        AvaloniaProperty.Register<PlayerHeadView, Bitmap?>(nameof(Skin));

    public static readonly StyledProperty<double> YawProperty =
        AvaloniaProperty.Register<PlayerHeadView, double>(nameof(Yaw));

    public static readonly StyledProperty<double> PitchProperty =
        AvaloniaProperty.Register<PlayerHeadView, double>(nameof(Pitch));

    public Bitmap? Skin
    {
        get => GetValue(SkinProperty);
        set => SetValue(SkinProperty, value);
    }

    /// <summary>Horizontal rotation in radians.</summary>
    public double Yaw
    {
        get => GetValue(YawProperty);
        set => SetValue(YawProperty, value);
    }

    /// <summary>Vertical rotation in radians.</summary>
    public double Pitch
    {
        get => GetValue(PitchProperty);
        set => SetValue(PitchProperty, value);
    }

    static PlayerHeadView()
    {
        AffectsRender<PlayerHeadView>(SkinProperty, YawProperty, PitchProperty);
    }

    public override void Render(DrawingContext context)
    {
        base.Render(context);

        if (Skin is null || Bounds.Width <= 0 || Bounds.Height <= 0)
            return;

        var w = Bounds.Width;
        var h = Bounds.Height;
        var scale = Math.Min(w, h) * 1.35; // cube is ~0.5 units wide; fit it to the control
        var cx = w / 2;
        var cy = h / 2 + Math.Min(w, h) * 0.05;

        var cosY = (float)Math.Cos(Yaw);
        var sinY = (float)Math.Sin(Yaw);
        var cosX = (float)Math.Cos(Pitch);
        var sinX = (float)Math.Sin(Pitch);

        var vertices = PlayerHeadModel.Vertices;
        var projected = new Point[vertices.Length];
        var depth = new float[vertices.Length];

        for (var i = 0; i < vertices.Length; i++)
        {
            var v = vertices[i];

            // Center the cube on its own middle (model Y spans [0, 0.5]) before rotating.
            var x = v.X;
            var y = v.Y - 0.25f;
            var z = v.Z;

            // Yaw (around Y axis), then pitch (around X axis).
            var x1 = x * cosY + z * sinY;
            var z1 = -x * sinY + z * cosY;
            var y1 = y * cosX - z1 * sinX;
            var z2 = y * sinX + z1 * cosX;

            projected[i] = new Point(cx + x1 * scale, cy - y1 * scale);
            depth[i] = z2;
        }

        // Depth-sort triangles back-to-front (painter's algorithm — sufficient for a convex cube).
        var indices = PlayerHeadModel.Indices;
        var triangleCount = indices.Length / 3;
        var order = Enumerable.Range(0, triangleCount).ToArray();

        Array.Sort(order, (a, b) =>
        {
            var da = (depth[indices[a * 3]] + depth[indices[a * 3 + 1]] + depth[indices[a * 3 + 2]]) / 3;
            var db = (depth[indices[b * 3]] + depth[indices[b * 3 + 1]] + depth[indices[b * 3 + 2]]) / 3;
            return da.CompareTo(db);
        });

        var uvs = PlayerHeadModel.Uvs;
        var texW = Skin.PixelSize.Width;
        var texH = Skin.PixelSize.Height;

        foreach (var t in order)
        {
            var i0 = indices[t * 3];
            var i1 = indices[t * 3 + 1];
            var i2 = indices[t * 3 + 2];

            var p0 = projected[i0];
            var p1 = projected[i1];
            var p2 = projected[i2];

            DrawTexturedTriangle(context, Skin, texW, texH,
                p0, p1, p2,
                uvs[i0], uvs[i1], uvs[i2]);
        }
    }

    static void DrawTexturedTriangle(DrawingContext context, Bitmap skin, int texW, int texH,
        Point p0, Point p1, Point p2, Vec2 uv0, Vec2 uv1, Vec2 uv2)
    {
        // Source triangle in texture pixel space.
        var s0 = new Point(uv0.X * texW, uv0.Y * texH);
        var s1 = new Point(uv1.X * texW, uv1.Y * texH);
        var s2 = new Point(uv2.X * texW, uv2.Y * texH);

        // Affine map that sends the source triangle onto the destination triangle exactly
        // (an affine transform is fully determined by 3 point correspondences).
        var denom = (s1.X - s0.X) * (s2.Y - s0.Y) - (s2.X - s0.X) * (s1.Y - s0.Y);
        if (Math.Abs(denom) < 0.0001)
            return;

        var a = ((p1.X - p0.X) * (s2.Y - s0.Y) - (p2.X - p0.X) * (s1.Y - s0.Y)) / denom;
        var b = ((p1.Y - p0.Y) * (s2.Y - s0.Y) - (p2.Y - p0.Y) * (s1.Y - s0.Y)) / denom;
        var c = ((p2.X - p0.X) * (s1.X - s0.X) - (p1.X - p0.X) * (s2.X - s0.X)) / denom;
        var d = ((p2.Y - p0.Y) * (s1.X - s0.X) - (p1.Y - p0.Y) * (s2.X - s0.X)) / denom;
        var e = p0.X - a * s0.X - c * s0.Y;
        var f = p0.Y - b * s0.X - d * s0.Y;

        var matrix = new Matrix(a, b, c, d, e, f);

        using var clip = context.PushGeometryClip(new PolylineGeometry(new[] { p0, p1, p2 }, true));
        using var transform = context.PushTransform(matrix);
        context.DrawImage(skin, new Rect(0, 0, texW, texH));
    }
}
