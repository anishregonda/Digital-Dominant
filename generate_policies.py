import glob
import os
import re

html_files = glob.glob("d:/Digital dominant/*.html")

privacy_html = """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Privacy Policy - Digital Dominant</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="style.css" />
    <style>
      .policy-container {
        max-width: 800px;
        margin: 150px auto 100px;
        padding: 0 2rem;
      }
      .policy-container h1 { margin-bottom: 1rem; color: var(--accent-primary); }
      .policy-container h2 { margin-top: 2rem; margin-bottom: 1rem; color: var(--text-primary); }
      .policy-container h3 { margin-top: 1.5rem; margin-bottom: 0.5rem; color: var(--text-primary); }
      .policy-container p, .policy-container li { margin-bottom: 1rem; line-height: 1.6; color: var(--text-secondary); }
      .policy-container ul { margin-left: 2rem; margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <nav class="navbar">
      <div class="container nav-container">
        <div class="logo">
          <a href="index.html"><img src="logo.png" alt="Digital Dominant Logo" class="logo-img" /></a>
        </div>
        <div class="menu-toggle" id="mobile-menu">
          <span class="bar"></span>
          <span class="bar"></span>
          <span class="bar"></span>
        </div>
        <div class="nav-links">
          <a href="index.html">Home</a>
          <a href="about.html">About</a>
          <a href="portfolio.html">Portfolio</a>
          <a href="pricing.html">Pricing</a>
          <a href="testimonials.html">Testimonials</a>
          <a href="contact.html">Contact</a>
        </div>
        <a href="https://calendly.com/digitaldominant/30min?month=2026-06" target="_blank" class="btn btn-primary nav-btn">Book a call</a>
      </div>
    </nav>

    <div class="policy-container">
      <h1>Privacy Policy</h1>
      <p>Last updated: May 12, 2026</p>
      <p>This Privacy Policy describes Our policies and procedures on the collection, use and disclosure of Your information when You use the Service and tells You about Your privacy rights and how the law protects You.</p>
      
      <h2>Interpretation and Definitions</h2>
      <h3>Interpretation</h3>
      <p>The words of which the initial letter is capitalized have meanings defined under the following conditions. The following definitions shall have the same meaning regardless of whether they appear in singular or in plural.</p>
      
      <h3>Definitions</h3>
      <p>For the purposes of this Privacy Policy:</p>
      <ul>
        <li><strong>Company</strong> (referred to as either "the Company", "We", "Us" or "Our" in this Agreement) refers to Digital Dominant, a reputation management agency, providing services such as online review monitoring, reputation repair, social media profile management, and improving clients' online presence. Operated by Chiranjivi Patel, 1st Floor, 12-13-1164 Gokhale Nagar Street 11 Near Kalakruti, 500017 Secunderabad, Rangareddy, Telangana, India.</li>
        <li><strong>Country</strong> refers to: Telangana, India</li>
        <li><strong>Website</strong> refers to Digital Dominant, accessible from <a href="https://www.digitaldominant.co.uk">https://www.digitaldominant.co.uk</a></li>
      </ul>

      <h2>Collecting and Using Your Personal Data</h2>
      <h3>Types of Data Collected</h3>
      <p>While using Our Service, We may ask You to provide Us with certain personally identifiable information that can be used to contact or identify You. Personally identifiable information may include, but is not limited to: Email address, First name and last name, Phone number, Usage Data.</p>
      
      <h3>Use of Your Personal Data</h3>
      <p>The Company may use Personal Data for the following purposes: To provide and maintain our Service, including to monitor the usage of our Service. To manage Your Account, for the performance of a contract, to contact You, to provide You with news and general information about other goods, services and events.</p>

      <h2>Contact Us</h2>
      <p>If you have any questions about this Privacy Policy, You can contact us:</p>
      <ul>
        <li>By email: info@digitaldominant.co.uk</li>
      </ul>
    </div>

    <footer class="footer">
      <div class="container footer-grid">
        <div class="footer-col">
          <div class="logo">
            <a href="index.html"><img src="logo.png" alt="Digital Dominant Logo" class="logo-img" /></a>
          </div>
          <p style="margin-top: 1rem;">(888) 555-1234</p>
        </div>
        <div class="footer-col">
          <h4>Navigation</h4>
          <a href="index.html">Home</a>
          <a href="testimonials.html">Testimonials</a>
          <a href="portfolio.html">Portfolio</a>
          <a href="pricing.html">Pricing</a>
        </div>
        <div class="footer-col">
          <h4>Company</h4>
          <a href="about.html">What We Do</a>
          <a href="about.html">About</a>
          <a href="contact.html">Contact US</a>
          <a href="privacy-policy.html">Privacy Policy</a>
          <a href="terms-conditions.html">Terms & Conditions</a>
        </div>
        <div class="footer-col">
          <h4>Action</h4>
          <a href="https://calendly.com/digitaldominant/30min?month=2026-06" target="_blank">Schedule a call</a>
          <a href="https://www.instagram.com/digitaldominant.co.uk/?hl=en" target="_blank">Instagram</a>
        </div>
      </div>
      <div class="footer-bottom container">
        <p>&copy; Copyright 2026 | All rights reserved | Digital Dominant</p>
      </div>
    </footer>

    <script>
      const mobileMenu = document.getElementById('mobile-menu');
      const navLinks = document.querySelector('.nav-links');
      
      if (mobileMenu && navLinks) {
        mobileMenu.addEventListener('click', () => {
          mobileMenu.classList.toggle('active');
          navLinks.classList.toggle('active');
        });
        const links = navLinks.querySelectorAll('a');
        links.forEach(link => {
          link.addEventListener('click', () => {
            mobileMenu.classList.remove('active');
            navLinks.classList.remove('active');
          });
        });
      }
    </script>
  </body>
</html>
"""

terms_html = privacy_html.replace("<title>Privacy Policy - Digital Dominant</title>", "<title>Terms and Conditions - Digital Dominant</title>")

terms_content = """
      <h1>Terms and Conditions</h1>
      <p>Last updated: March 21, 2026</p>
      <p>Please read these Terms and Conditions carefully before using Our Service.</p>
      
      <h2>Interpretation and Definitions</h2>
      <h3>Interpretation</h3>
      <p>The words of which the initial letter is capitalized have meanings defined under the following conditions. The following definitions shall have the same meaning regardless of whether they appear in singular or in plural.</p>
      
      <h3>Definitions</h3>
      <p>For the purposes of these Terms and Conditions:</p>
      <ul>
        <li><strong>Company</strong> (referred to as either "the Company", "We", "Us" or "Our" in this Agreement) refers to Digital Dominant, a reputation management agency, providing services such as online review monitoring, reputation repair, social media profile management, and improving clients' online presence. Operated by Chiranjivi Patel, 1st Floor, 12-13-1164 Gokhale Nagar Street 11 Near Kalakruti, 500017 Secunderabad, Rangareddy, Telangana, India.</li>
        <li><strong>Country</strong> refers to: Telangana, India</li>
        <li><strong>Website</strong> refers to Digital Dominant, accessible from <a href="https://www.digitaldominant.co.uk">https://www.digitaldominant.co.uk</a></li>
      </ul>

      <h2>Acknowledgment</h2>
      <p>These are the Terms and Conditions governing the use of this Service and the agreement that operates between You and the Company. These Terms and Conditions set out the rights and obligations of all users regarding the use of the Service.</p>
      
      <h2>Reputation Management Services</h2>
      <p>Digital Dominant provides online reputation management services, including review monitoring, reputation repair strategies, social media profile management, and related consulting.</p>
      <p><strong>Important Disclaimer:</strong> Reputation management outcomes depend on many external factors including client actions, platform policies, and third-party behavior. We do not guarantee specific results, such as removal of all negative reviews, improvement in ratings, or any particular business outcome. All services are provided on a best-effort basis.</p>

      <h2>Limitation of Liability</h2>
      <p>To the maximum extent permitted by applicable law, in no event shall the Company, its owners, or suppliers be liable for any indirect, incidental, special, consequential or punitive damages, or any loss of profits or data, arising out of or in connection with these Terms or the use of the Service.</p>

      <h2>Contact Us</h2>
      <p>If you have any questions about these Terms and Conditions, You can contact us:</p>
      <ul>
        <li>By email: info@digitaldominant.co.uk</li>
      </ul>
"""

terms_html = re.sub(r'<div class="policy-container">.*?</div>', f'<div class="policy-container">\n{terms_content}\n    </div>', terms_html, flags=re.DOTALL)

with open("d:/Digital dominant/privacy-policy.html", "w", encoding="utf-8") as f:
    f.write(privacy_html)

with open("d:/Digital dominant/terms-conditions.html", "w", encoding="utf-8") as f:
    f.write(terms_html)

for f in html_files:
    # Skip the ones we just generated if they happen to be listed (they shouldn't be yet)
    if 'privacy-policy.html' in f or 'terms-conditions.html' in f:
        continue
        
    with open(f, 'r', encoding='utf-8') as file:
        content = file.read()
        
    # Update links
    content = content.replace('href="#">Privacy Policy</a>', 'href="privacy-policy.html">Privacy Policy</a>')
    content = content.replace('href="#">Terms & Conditions</a>', 'href="terms-conditions.html">Terms & Conditions</a>')
    content = content.replace('href="#">Instagram</a>', 'href="https://www.instagram.com/digitaldominant.co.uk/?hl=en" target="_blank">Instagram</a>')
    
    with open(f, 'w', encoding='utf-8') as file:
        file.write(content)
