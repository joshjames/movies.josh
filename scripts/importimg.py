import os
from PIL import Image, ImageDraw

# Load the image
image_path = "avatars.png" 
img = Image.open(image_path).convert('RGBA')
img_w, img_h = img.size

# -------------------------------------------------------------------------
# Crop the main image boundaries roughly past the hidden black bar
# -------------------------------------------------------------------------
start_y = 0
for y in range(img_h):
    r, g, b, a = img.getpixel((img_w // 2, y))
    if r > 240 and g > 240 and b > 240:
        start_y = y
        break

sample_y = start_y + 50 
start_x = 0
for x in range(img_w):
    r, g, b, a = img.getpixel((x, sample_y))
    if r < 250 or g < 250 or b < 250:
        start_x = x
        break

end_x = img_w
for x in range(img_w - 1, -1, -1):
    r, g, b, a = img.getpixel((x, sample_y))
    if r < 250 or g < 250 or b < 250:
        end_x = x + 1
        break

cleaned_img = img.crop((start_x, start_y, end_x, img_h))
cleaned_w, cleaned_h = cleaned_img.size

# Output folder setup
output_dir = "extracted_avatars_perfect"
os.makedirs(output_dir, exist_ok=True)

COLS = 17
ROWS = 8

tile_w = cleaned_w / COLS
tile_h = cleaned_h / ROWS

count = 1
for r in range(ROWS):
    for c in range(COLS):
        left = int(c * tile_w)
        top = int(r * tile_h)
        right = int((c + 1) * tile_w)
        bottom = int((r + 1) * tile_h)
        
        # 1. Grab the rough square tile area
        avatar = cleaned_img.crop((left, top, right, bottom)).convert('RGBA')
        w, h = avatar.size
        
        # 2. DYNAMICALLY FIND THE CIRCLE BOUNDS INSIDE THIS TILE
        # Scan the tile pixels to find the extreme edges of the pink circle
        min_x, min_y = w, h
        max_x, max_y = 0, 0
        has_circle = False
        
        for y_pixel in range(h):
            for x_pixel in range(w):
                pr, pg, pb, pa = avatar.getpixel((x_pixel, y_pixel))
                
                # Identify the circle color (it's a distinct pink/beige, definitely not white background)
                if pr < 252 or pg < 245 or pb < 240: 
                    has_circle = True
                    if x_pixel < min_x: min_x = x_pixel
                    if x_pixel > max_x: max_x = x_pixel
                    if y_pixel < min_y: min_y = y_pixel
                    if y_pixel > max_y: max_y = y_pixel
        
        # Fallback to center if the pixel detection misses entirely
        if not has_circle or (max_x <= min_x) or (max_y <= min_y):
            min_x, min_y, max_x, max_y = 0, 0, w, h
            
        # 3. Calculate the true diameter and center based on the detected edges
        circle_w = max_x - min_x
        circle_h = max_y - min_y
        
        # Use the average radius to keep it a perfect sphere
        radius = (circle_w + circle_h) / 4
        center_x = min_x + (circle_w / 2)
        center_y = min_y + (circle_h / 2)
        
        # 4. Generate the mask centered on the true calculated coordinates
        mask = Image.new('L', (w, h), 0)
        draw = ImageDraw.Draw(mask)
        
        # Tuck the radius in by 1.5 pixels to cleanly slice off the anti-aliased edge fuzz
        shave = 1.5
        r_clean = radius - shave
        
        draw.ellipse([
            center_x - r_clean, 
            center_y - r_clean, 
            center_x + r_clean, 
            center_y + r_clean
        ], fill=255)
        
        # Apply mask and save
        avatar.putalpha(mask)
        avatar.save(os.path.join(output_dir, f"avatar_{count:03d}.png"), "PNG")
        count += 1

print(f"Done! Dynamically tracked each circle center and saved {count-1} perfect PNGs.")