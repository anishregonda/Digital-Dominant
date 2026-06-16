import glob

html_files = glob.glob("d:/Digital dominant/*.html")

old_js = """    <script>
      const mobileMenu = document.getElementById('mobile-menu');
      const navLinks = document.querySelector('.nav-links');
      if (mobileMenu) {
        mobileMenu.addEventListener('click', () => {
          mobileMenu.classList.toggle('active');
          navLinks.classList.toggle('active');
        });
      }
    </script>"""

new_js = """    <script>
      const mobileMenu = document.getElementById('mobile-menu');
      const navLinks = document.querySelector('.nav-links');
      
      if (mobileMenu && navLinks) {
        // Toggle menu on hamburger click
        mobileMenu.addEventListener('click', () => {
          mobileMenu.classList.toggle('active');
          navLinks.classList.toggle('active');
        });

        // Close menu when any link inside it is clicked
        const links = navLinks.querySelectorAll('a');
        links.forEach(link => {
          link.addEventListener('click', () => {
            mobileMenu.classList.remove('active');
            navLinks.classList.remove('active');
          });
        });
      }
    </script>"""

for f in html_files:
    with open(f, 'r', encoding='utf-8') as file:
        content = file.read()
    
    if old_js in content:
        content = content.replace(old_js, new_js)
        with open(f, 'w', encoding='utf-8') as file:
            file.write(content)
        print(f"Updated {f}")
    else:
        # Just in case there's slight indentation differences
        import re
        # Find the script block and replace
        pattern = re.compile(r'<script>\s*const mobileMenu = document\.getElementById\(\'mobile-menu\'\);\s*const navLinks = document\.querySelector\(\'\.nav-links\'\);\s*if \(mobileMenu\) \{\s*mobileMenu\.addEventListener\(\'click\', \(\) => \{\s*mobileMenu\.classList\.toggle\(\'active\'\);\s*navLinks\.classList\.toggle\(\'active\'\);\s*\}\);\s*\}\s*</script>')
        if pattern.search(content):
            content = pattern.sub(new_js, content)
            with open(f, 'w', encoding='utf-8') as file:
                file.write(content)
            print(f"Updated {f} using regex")
