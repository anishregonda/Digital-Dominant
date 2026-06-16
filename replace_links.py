import glob
import re

for filename in glob.glob('d:/Digital dominant/*.html'):
    with open(filename, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Replace href="book.html" with the calendly link
    new_content = content.replace('href="book.html"', 'href="https://calendly.com/digitaldominant/30min?month=2026-06" target="_blank"')
    
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(new_content)
print("Replacement complete.")
