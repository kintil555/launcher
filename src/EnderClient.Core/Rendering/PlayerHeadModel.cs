namespace EnderClient.Core.Rendering;

/// <summary>
/// Vertex/UV/triangle data for a standard Minecraft player head cube (8x8x8 px in skin space),
/// centered on X/Z with its base at Y=0. Extracted once from a Blockbench glTF export — a
/// player head never changes shape, so this is baked as static data rather than parsed at
/// runtime from a glTF file.
/// </summary>
public static class PlayerHeadModel
{
    public static readonly Vec3[] Vertices =
    {
        new(0.250000f, 0.500000f, 0.250000f),
        new(0.250000f, 0.500000f, -0.250000f),
        new(0.250000f, 0.000000f, 0.250000f),
        new(0.250000f, 0.000000f, -0.250000f),
        new(-0.250000f, 0.500000f, -0.250000f),
        new(-0.250000f, 0.500000f, 0.250000f),
        new(-0.250000f, 0.000000f, -0.250000f),
        new(-0.250000f, 0.000000f, 0.250000f),
        new(-0.250000f, 0.500000f, -0.250000f),
        new(0.250000f, 0.500000f, -0.250000f),
        new(-0.250000f, 0.500000f, 0.250000f),
        new(0.250000f, 0.500000f, 0.250000f),
        new(-0.250000f, 0.000000f, 0.250000f),
        new(0.250000f, 0.000000f, 0.250000f),
        new(-0.250000f, 0.000000f, -0.250000f),
        new(0.250000f, 0.000000f, -0.250000f),
        new(-0.250000f, 0.500000f, 0.250000f),
        new(0.250000f, 0.500000f, 0.250000f),
        new(-0.250000f, 0.000000f, 0.250000f),
        new(0.250000f, 0.000000f, 0.250000f),
        new(0.250000f, 0.500000f, -0.250000f),
        new(-0.250000f, 0.500000f, -0.250000f),
        new(0.250000f, 0.000000f, -0.250000f),
        new(-0.250000f, 0.000000f, -0.250000f),
    };

    public static readonly Vec2[] Uvs =
    {
        new(0.000244f, 0.125244f),
        new(0.124756f, 0.125244f),
        new(0.000244f, 0.249756f),
        new(0.124756f, 0.249756f),
        new(0.250244f, 0.125244f),
        new(0.374756f, 0.125244f),
        new(0.250244f, 0.249756f),
        new(0.374756f, 0.249756f),
        new(0.249756f, 0.124756f),
        new(0.125244f, 0.124756f),
        new(0.249756f, 0.000244f),
        new(0.125244f, 0.000244f),
        new(0.374756f, 0.000244f),
        new(0.250244f, 0.000244f),
        new(0.374756f, 0.124756f),
        new(0.250244f, 0.124756f),
        new(0.375244f, 0.125244f),
        new(0.499756f, 0.125244f),
        new(0.375244f, 0.249756f),
        new(0.499756f, 0.249756f),
        new(0.125244f, 0.125244f),
        new(0.249756f, 0.125244f),
        new(0.125244f, 0.249756f),
        new(0.249756f, 0.249756f),
    };

    /// <summary>Triangles as index triples into <see cref="Vertices"/>/<see cref="Uvs"/>.</summary>
    public static readonly int[] Indices =
    {
        0, 2, 1, 2, 3, 1,
        4, 6, 5, 6, 7, 5,
        8, 10, 9, 10, 11, 9,
        12, 14, 13, 14, 15, 13,
        16, 18, 17, 18, 19, 17,
        20, 22, 21, 22, 23, 21
    };
}
