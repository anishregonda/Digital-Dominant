import glob

html_files = glob.glob("d:/Digital dominant/*.html")

for f in html_files:
    with open(f, 'r', encoding='utf-8') as file:
        content = file.read()
    
    if 'class="menu-toggle"' in content:
        continue
        
    toggle_html = '\n        <div class="menu-toggle" id="mobile-menu">\n          <span class="bar"></span>\n          <span class="bar"></span>\n          <span class="bar"></span>\n        </div>\n        <div class="nav-links">'
    content = content.replace('<div class="nav-links">', toggle_html)
    
    js_code = """
    <script>
      const mobileMenu = document.getElementById('mobile-menu');
      const navLinks = document.querySelector('.nav-links');
      if (mobileMenu) {
        mobileMenu.addEventListener('click', () => {
          mobileMenu.classList.toggle('active');
          navLinks.classList.toggle('active');
        });
      }
    </script>
  </body>"""
    content = content.replace('</body>', js_code)
    
    with open(f, 'w', encoding='utf-8') as file:
        file.write(content)
