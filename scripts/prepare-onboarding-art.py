"""Prepare local watercolor textures for onboarding; no remote generation."""
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
target = root / "src/assets/onboarding"
target.mkdir(parents=True, exist_ok=True)
recipes = [
    ("src/assets/nature.webp", "arrival-lake.webp", (640, 960)),
    ("src/assets/decor/settings-paper-v1.png", "chapter-paper.webp", (960, 640)),
    ("src/assets/decor/character-card-vine-v1.png", "vine-frame.webp", (480, 720)),
    ("src/assets/leaf-corner-v1.png", "leaf-corner.webp", (400, 400)),
    ("src/assets/decor/empty-state-lakeshore-v1.png", "lake-note.webp", (720, 480)),
]
for source, name, size in recipes:
    image = Image.open(root / source)
    image = ImageOps.fit(image, size, method=Image.Resampling.LANCZOS)
    image.save(target / name, "WEBP", quality=86, method=6)
    print(f"{name}: {image.width}x{image.height}, {(target / name).stat().st_size} bytes")
