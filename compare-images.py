from PIL import Image
import imagehash
from pathlib import Path
import os
import argparse
import time
import webbrowser 
import tempfile # <--- New import for temporary file handling

# --- Configuration ---
HASH_ALGORITHM = imagehash.phash 
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.bmp', '.tiff')
# --- HTML Template (Minimalist and crisp) ---
HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Image Similarity Report</title>
    <style>
        body {{ font-family: 'Helvetica Neue', Arial, sans-serif; margin: 20px; background-color: #f0f0f0; }}
        h1 {{ color: #333; border-bottom: 2px solid #ccc; padding-bottom: 10px; }}
        .pair-container {{ 
            display: flex; 
            margin-bottom: 30px; 
            padding: 15px; 
            background-color: white; 
            border-radius: 8px; 
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            border-left: 5px solid {color}; 
        }}
        .image-box {{ flex: 1; padding: 10px; text-align: center; }}
        .image-box img {{ max-width: 100%; height: auto; border: 1px solid #ddd; border-radius: 4px; }}
        .metadata {{ width: 150px; text-align: center; padding: 10px; margin-right: 15px; border-right: 1px dashed #eee; }}
        .distance-score {{ font-size: 2.5em; font-weight: bold; color: {color}; }}
        .file-path {{ font-size: 0.8em; color: #666; word-break: break-all; margin-top: 5px; }}
    </style>
</head>
<body>
    <h1>Image Similarity Cross-Reference Report</h1>
    <p>Found {count} pairs above threshold {threshold}. Sorted by Distance (Most Similar First).</p>
    {content}
</body>
</html>
"""

# --- Core Functions (kept minimal) ---

def find_image_files(directory):
    return [p for p in Path(directory).rglob('*') if p.suffix.lower() in IMAGE_EXTENSIONS]

def generate_hashes(image_paths, hash_func, dir_name):
    hashes = {}
    for path in image_paths:
        try:
            img = Image.open(path)
            h = hash_func(img)
            hashes[h] = hashes.get(h, []) + [path]
        except Exception:
            pass 
    return hashes

def cross_reference_hashes(hashes_a, hashes_b, threshold):
    keys_a = list(hashes_a.keys())
    matching_pairs = []
    
    for h_a in keys_a:
        for h_b, paths_b in hashes_b.items(): 
            distance = h_a - h_b
            if distance <= threshold:
                paths_a = hashes_a[h_a]
                for p_a in paths_a:
                    for p_b in paths_b:
                        if p_a != p_b:
                            matching_pairs.append((p_a, p_b, distance))
    return matching_pairs

def get_color_by_distance(distance, max_dist=3):
    """Assigns a color based on similarity for visual elegance."""
    if distance == 0:
        return '#4CAF50' # Green (Perfect Match)
    if distance <= 1:
        return '#2196F3' # Blue (Almost Perfect)
    if distance <= max_dist:
        return '#FFC107' # Yellow/Orange (Highly Similar)
    return '#E91E63' # Red (Lower Similarity)

# --- REVISED: HTML Generation Function ---

def create_comparison_html(matches, dir_a_root, dir_b_root, threshold):
    """Generates the HTML file in a temporary location and opens it."""
    
    sorted_matches = sorted(matches, key=lambda x: x[2])
    content = ""
    max_threshold = threshold 

    for p_a, p_b, dist in sorted_matches:
        color = get_color_by_distance(dist, max_threshold)
        
        # Use relative paths for display
        rel_path_a = p_a.relative_to(dir_a_root)
        rel_path_b = p_b.relative_to(dir_b_root)

        # Use absolute file:/// protocol paths for the browser
        img_src_a = p_a.resolve().as_uri()
        img_src_b = p_b.resolve().as_uri()
        
        pair_html = f"""
        <div class="pair-container" style="border-left: 5px solid {color};">
            <div class="metadata">
                <div style="font-size: 1.1em; font-weight: 500;">Hamming Distance</div>
                <div class="distance-score" style="color: {color};">{dist}</div>
                <div style="font-size: 0.9em; color: #888;">({HASH_ALGORITHM.__name__})</div>
            </div>
            
            <div class="image-box">
                <img src="{img_src_a}" alt="Image A">
                <div class="file-path">Dir A: {rel_path_a}</div>
            </div>
            
            <div class="image-box">
                <img src="{img_src_b}" alt="Image B">
                <div class="file-path">Dir B: {rel_path_b}</div>
            </div>
        </div>
        """
        content += pair_html

    # Fill the template
    final_html = HTML_TEMPLATE.format(
        content=content, 
        count=len(matches), 
        threshold=threshold,
        color=get_color_by_distance(0)
    )
    
    # Use NamedTemporaryFile to create a temporary file
    # We use delete=False so the file is not immediately deleted when closed, 
    # allowing the browser time to open it. We must ensure to close the file handle (f).
    # Suffix ensures the browser recognizes it as HTML.
    with tempfile.NamedTemporaryFile(mode='w', suffix='.html', delete=False, encoding='utf-8') as f:
        f.write(final_html)
        temp_filename = f.name
        
    print(f"\n✨ Temporary HTML Report generated at: {temp_filename}")
    
    # Open it in the browser
    webbrowser.open(f'file:///{Path(temp_filename).resolve()}')


# --- Main Execution Function ---
def main():
    parser = argparse.ArgumentParser(
        description="Cross-reference images in two directories using pHash and generate a temporary visual HTML report.",
    )
    
    parser.add_argument('dir_a', type=str, help="Path to the first source directory.")
    parser.add_argument('dir_b', type=str, help="Path to the second source directory.")
    parser.add_argument('-t', '--threshold', type=int, default=2,
                        help="Hamming distance threshold for similarity (0-64). Default is 2.")
    
    args = parser.parse_args()

    # Input validation and setup
    dir_a_path = Path(args.dir_a)
    dir_b_path = Path(args.dir_b)
    
    if not dir_a_path.is_dir() or not dir_b_path.is_dir():
        print("Error: One or both directories not found.")
        return

    start_time = time.time()
    
    print(f"\n--- Starting pHash Comparison ---")
    
    # 1. Get all image file paths
    images_a = find_image_files(dir_a_path)
    images_b = find_image_files(dir_b_path)
    
    # 2. Generate Hashes
    hashes_a = generate_hashes(images_a, HASH_ALGORITHM, "Dir A")
    hashes_b = generate_hashes(images_b, HASH_ALGORITHM, "Dir B")

    # 3. Cross-Reference Hashes
    matches = cross_reference_hashes(hashes_a, hashes_b, args.threshold)
    
    # 4. Generate HTML and Display
    if matches:
        create_comparison_html(matches, dir_a_path, dir_b_path, args.threshold)
    else:
        print("\n❌ No highly similar image pairs found above the threshold.")
        
    end_time = time.time()
    print(f"Total execution time: {end_time - start_time:.2f} seconds.")

if __name__ == "__main__":
    main()