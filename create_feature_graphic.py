from PIL import Image, ImageDraw

def create_feature_graphic():
    # 1. Create a 1024x500 background with the Prompt Maximize navy color
    width, height = 1024, 500
    bg_color = (15, 23, 42)  # #0f172a
    feature_graphic = Image.new('RGB', (width, height), bg_color)
    
    try:
        # 2. Load our elite icon
        icon_path = "prompt_maximize_icon.png"
        icon = Image.open(icon_path).convert("RGBA")
        
        # 3. Resize icon to fit nicely (e.g., 350x350)
        icon_size = 350
        icon.thumbnail((icon_size, icon_size), Image.Resampling.LANCZOS)
        
        # 4. Calculate centering position
        icon_w, icon_h = icon.size
        offset = ((width - icon_w) // 2, (height - icon_h) // 2)
        
        # 5. Paste icon onto background
        feature_graphic.paste(icon, offset, icon)
        
        # 6. Save the final file
        feature_graphic.save("feature_graphic.png", "PNG")
        print("Success: feature_graphic.png (1024x500) created successfully!")
        
    except Exception as e:
        print(f"Error creating feature graphic: {e}")

if __name__ == "__main__":
    create_feature_graphic()
