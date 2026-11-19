// Draws the helper app's icon as an .iconset folder for iconutil. scripts/build-helper-app.sh runs it.
// The website's "Kiko." mark (its apple-touch-icon and share image): the name's first
// letter in the system font's heavy weight, pale, the accent's rounded square dot after it, on Kiko's
// dark ground (lit a touch from the top, with a faint top edge so it holds on a dark Dock), on macOS's
// icon plate (the 1024 grid: an 824 continuous-corner square, 100 in, with a shadow under it). Every
// flavour gets the same icon; the iPhone app's icon and the website's use the same colours.
// Usage: icon <name or letter> <out.iconset>
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write("usage: icon <name or letter> <out.iconset>\n".data(using: .utf8)!)
    exit(2)
}
let letter = String(args[1].prefix(1)).uppercased()
let out = URL(fileURLWithPath: args[2])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func rgb(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}
// Kiko's dark colours: the ground (top, bottom), the pale wordmark, the accent.
let groundTop = rgb(0x18191f), groundBottom = rgb(0x0e0f13), ink = rgb(0xececef), accent = rgb(0x9aa8ff)

/// A rounded rect with continuous ("squircle") corners, as Apple's icon plate has.
func plate(_ rect: CGRect, radius: CGFloat) -> NSBezierPath {
    let r = min(radius, min(rect.width, rect.height) / 2 / 1.52866483)
    // One corner, as (back along the edge coming in, on along the edge going out), in radii.
    let corner: [(to: (CGFloat, CGFloat), c1: (CGFloat, CGFloat)?, c2: (CGFloat, CGFloat)?)] = [
        ((0.66993427, 0.06549600), (1.08849323, 0), (0.86840689, 0)),
        ((0.63149399, 0.07491100), nil, nil),
        ((0.07491100, 0.63149399), (0.37282392, 0.16905899), (0.16905899, 0.37282392)),
        ((0.06549600, 0.66993427), nil, nil),
        ((0, 1.52866483), (0, 0.86840689), (0, 1.08849323)),
    ]
    // Clockwise from the top left: each corner's point, the way in (back), the way out.
    let corners: [(CGPoint, CGVector, CGVector)] = [
        (CGPoint(x: rect.maxX, y: rect.maxY), CGVector(dx: -1, dy: 0), CGVector(dx: 0, dy: -1)),
        (CGPoint(x: rect.maxX, y: rect.minY), CGVector(dx: 0, dy: 1), CGVector(dx: -1, dy: 0)),
        (CGPoint(x: rect.minX, y: rect.minY), CGVector(dx: 1, dy: 0), CGVector(dx: 0, dy: 1)),
        (CGPoint(x: rect.minX, y: rect.maxY), CGVector(dx: 0, dy: -1), CGVector(dx: 1, dy: 0)),
    ]
    let path = NSBezierPath()
    for (i, (c, back, on)) in corners.enumerated() {
        func p(_ a: CGFloat, _ b: CGFloat) -> CGPoint {
            CGPoint(x: c.x + (a * back.dx + b * on.dx) * r, y: c.y + (a * back.dy + b * on.dy) * r)
        }
        if i == 0 { path.move(to: p(1.52866483, 0)) } else { path.line(to: p(1.52866483, 0)) }
        for s in corner {
            if let c1 = s.c1, let c2 = s.c2 {
                path.curve(to: p(s.to.0, s.to.1), controlPoint1: p(c1.0, c1.1), controlPoint2: p(c2.0, c2.1))
            } else {
                path.line(to: p(s.to.0, s.to.1))
            }
        }
    }
    path.close()
    return path
}

/// The site's wordmark: `word` heavy, tightly kerned, the accent's rounded square after it. Its
/// baseline at `baseline`, from `x`. Returns the width.
@discardableResult
func wordmark(_ word: String, size: CGFloat, x: CGFloat, baseline: CGFloat, measureOnly: Bool = false) -> CGFloat {
    let font = NSFont.systemFont(ofSize: size, weight: .heavy)
    let s = NSAttributedString(string: word, attributes: [.font: font, .foregroundColor: ink, .kern: -0.035 * size])
    let w = s.size().width
    let dot = 0.22 * size, gap = 0.06 * size
    if !measureOnly {
        s.draw(at: NSPoint(x: x, y: baseline + font.descender))
        accent.setFill()
        NSBezierPath(roundedRect: CGRect(x: x + w + gap, y: baseline, width: dot, height: dot), xRadius: 0.045 * size, yRadius: 0.045 * size).fill()
    }
    return w + gap + dot
}

func png(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px) / 1024 // the 1024 grid
    let rect = CGRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let shape = plate(rect, radius: 185.4 * s)
    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(white: 0, alpha: 0.3)
    shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
    shadow.shadowBlurRadius = 20 * s
    shadow.set()
    groundBottom.setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()
    NSGradient(starting: groundTop, ending: groundBottom)!.draw(in: shape, angle: -90)
    // A hairline along the top edge, fading out down the sides.
    let cg = NSGraphicsContext.current!.cgContext
    cg.saveGState()
    cg.addPath(shape.cgPath)
    cg.clip()
    cg.addPath(shape.cgPath)
    cg.setLineWidth(max(1, 3 * s) * 2) // half of it falls outside the plate, clipped
    cg.replacePathWithStrokedPath()
    cg.clip()
    let edge = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [
        CGColor(gray: 1, alpha: 0.16), CGColor(gray: 1, alpha: 0),
    ] as CFArray, locations: [0, 1])!
    cg.drawLinearGradient(edge, start: CGPoint(x: 0, y: rect.maxY), end: CGPoint(x: 0, y: rect.maxY - rect.height * 0.4), options: [])
    cg.restoreGState()
    // The apple-touch-icon's mark (132 on 180), scaled to the plate.
    let k = rect.width / 180
    let size = 132 * k
    let w = wordmark(letter, size: size, x: 0, baseline: 0, measureOnly: true)
    wordmark(letter, size: size, x: rect.minX + (rect.width - w) / 2 - 4 * k, baseline: rect.minY + 40 * k)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for base in [16, 32, 128, 256, 512] {
    try png(base).write(to: out.appendingPathComponent("icon_\(base)x\(base).png"))
    try png(base * 2).write(to: out.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
}
