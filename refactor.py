import os
import re

directory = r"d:\Digital dominant"

# 1. Update font and style.css
style_path = os.path.join(directory, "style.css")
with open(style_path, "r", encoding="utf-8") as f:
    css_content = f.read()

# Update fonts
css_content = css_content.replace("'Montserrat', sans-serif", "'Inter', sans-serif")
# Remove text-transform: uppercase
css_content = css_content.replace("  text-transform: uppercase;\n", "")
# Ensure CTA button is orange
# Wait, let's make .btn-primary background-color: var(--accent-gold);
css_content = re.sub(r"\.btn-primary\s*\{\s*background-color:\s*var\(--accent-primary\);", ".btn-primary {\n  background-color: var(--accent-gold);", css_content)
css_content = re.sub(r"\.btn-primary:hover\s*\{\s*background-color:\s*var\(--accent-hover\);", ".btn-primary:hover {\n  background-color: #ea580c;", css_content)

with open(style_path, "w", encoding="utf-8") as f:
    f.write(css_content)

print("Updated style.css")

# 2. Update HTML files: Font link replacement
html_files = [f for f in os.listdir(directory) if f.endswith(".html")]

font_search = '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">'
font_replace = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">\n    <script src="https://unpkg.com/lucide@latest"></script>'

for file in html_files:
    if file == "index.html":
        continue # already updated
    filepath = os.path.join(directory, file)
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    
    if font_search in content:
        content = content.replace(font_search, font_replace)
    
    # Also add lucide.createIcons(); at the end
    if "</body>" in content and "lucide.createIcons" not in content:
        content = content.replace("</body>", "  <script>lucide.createIcons();</script>\n  </body>")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

print("Updated fonts in all HTML files.")

# 3. Update testimonials phrase
test_path = os.path.join(directory, "testimonials.html")
if os.path.exists(test_path):
    with open(test_path, "r", encoding="utf-8") as f:
        content = f.read()
    content = content.replace("See As Our Testimonials Speak", "Don't Just Take Our Word For It")
    with open(test_path, "w", encoding="utf-8") as f:
        f.write(content)

# 4. Update Portfolio
port_path = os.path.join(directory, "portfolio.html")
if os.path.exists(port_path):
    with open(port_path, "r", encoding="utf-8") as f:
        content = f.read()
    # Change card backgrounds to slate-50 / gray-100
    # Search for specific color classes or inline styles
    content = re.sub(r'style="[^"]*background-color:\s*(?:#[0-9a-fA-F]+|\w+)[^"]*"', 'style="background-color: #f8fafc;"', content)
    # If no inline background, inject it into portfolio-item cards if they exist. Wait, let's check portfolio.html later to be precise, or just use css for .portfolio-item
    with open(port_path, "w", encoding="utf-8") as f:
        f.write(content)

# 5. Update Contact page (split-screen)
contact_path = os.path.join(directory, "contact.html")
if os.path.exists(contact_path):
    with open(contact_path, "r", encoding="utf-8") as f:
        content = f.read()
    
    # Left side light
    content = content.replace("background-color: #111111;", "background-color: #ffffff;")
    content = content.replace("border-right: 1px solid #333;", "border-right: 1px solid #e5e7eb; background-color: #f9fafb;")
    content = content.replace("color: white;", "color: var(--text-primary);")
    content = content.replace("color: #ddd;", "color: var(--text-secondary);")
    content = content.replace("color: #aaa;", "color: var(--text-secondary);")
    content = content.replace("color: #666;", "color: var(--text-secondary);")
    # Form fields
    content = content.replace("background-color: #0a0a0a;", "background-color: #ffffff;")
    content = content.replace("border: 1px solid #333;", "border: 1px solid #d1d5db;")
    # Button
    content = content.replace("background-color: #c92a2a;", "background-color: var(--accent-gold);")
    content = content.replace("accent-color: #dc2626;", "accent-color: var(--accent-gold);")
    
    with open(contact_path, "w", encoding="utf-8") as f:
        f.write(content)
