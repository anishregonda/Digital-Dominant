import sys

# Testimonials to use
reviews = [
  ("Lisa Torres", "Owner, Sparkle Cleaning Co.", "I was skeptical at first but the results speak for themselves. 4.9 stars and 130+ reviews later — we're fully booked every week."),
  ("Tom Bradley", "Owner, Bradley Electric", "Our competitors have no idea how we're getting so many reviews. Digital Dominant is our secret weapon. Worth every penny."),
  ("Mike Johnson", "Owner, Johnson HVAC", "We went from 12 reviews to over 200 in just 6 months. Digital Dominant completely transformed our online presence. We're now the #1 HVAC company in our area on Google."),
  ("Jason P.", "Pressure Washing Business", "Digital Dominant completely changed how we attract customers. Our website, funnel, and review system now work together to bring in steady leads every week."),
  ("Sophie M.", "Salon Owner", "Digital Dominant helped us transform our online presence. From getting more 5-star reviews to launching a professional website and automated follow-ups — everything works seamlessly."),
  ("Mike R.", "Barbershop Owner", "Since partnering with Rahul, we've seen massive growth. The automation handles everything — reviews, calls, texts, and follow-ups. It's like having a full marketing team on autopilot."),
  ("Priya S.", "Med Spa Owner", "Our new website looks amazing, and the review automation boosted our credibility fast. Clients trust us more, and bookings have doubled."),
  ("Carlos D.", "Roofing Contractor", "The remarketing campaigns from Digital Dominant keep bringing customers back. We're finally getting consistent repeat business without extra effort."),
  ("Emma L.", "Dental Clinic Manager", "Digital Dominant made online growth simple. We get new reviews, website traffic, and customer calls — all automatically."),
  ("Noah K.", "Auto Detailing Business", "The AI review responses save us hours every week, and our customers love how engaged we seem online. It's a total game-changer."),
  ("Rachel T.", "Real Estate Agent", "Working with Digital Dominant gave our business a professional online image and a system that actually converts interest into paying customers.")
]

# Update testimonials.html
with open("testimonials.html", "r", encoding="utf-8") as f:
    content = f.read()

start_tag = '<div class="reviews-grid">'
end_tag = '</div>\\n      </div>\\n    </section>'
start_idx = content.find(start_tag)
end_idx = content.find(end_tag, start_idx)

if start_idx != -1 and end_idx != -1:
    new_grid = '<div class="reviews-grid">\\n'
    for r in reviews:
        new_grid += f'''
          <div class="review-card" data-aos="fade-up">
            <div class="review-header">
              <div class="reviewer-info">
                <h4>{r[0]}</h4>
                <span>{r[1]}</span>
              </div>
            </div>
            <div class="stars">★★★★★</div>
            <p class="review-text">"{r[2]}"</p>
          </div>
'''
    new_content = content[:start_idx] + new_grid + content[end_idx:]
    with open("testimonials.html", "w", encoding="utf-8") as f:
        f.write(new_content)

# Update index.html
with open("index.html", "r", encoding="utf-8") as f:
    idx_content = f.read()

import re

# 1. Pricing Preview Section
pricing_start = idx_content.find('<!-- Pricing Preview Section -->')
pricing_end = idx_content.find('<!-- Testimonials Section -->')

pricing_new = '''<!-- Pricing Preview Section -->
    <section class="strategy-call-section" id="pricing">
      <div class="container">
        <div class="strategy-layout">
          <div class="strategy-text" data-aos="fade-right">
            <span class="kicker" style="color: var(--accent-light); font-weight: 700; letter-spacing: 1px;">LET'S TALK</span>
            <h2 class="section-title" style="text-align: left; margin-top: 1rem;">Pricing Built Around <span style="color: var(--accent-light);">Your Business</span></h2>
            <p style="margin-bottom: 2rem; font-size: 1.1rem; color: var(--text-secondary);">We don't do one-size-fits-all. Book a free quick call and we'll put together a custom plan that fits your business, your market, and your budget.</p>
            <ul class="strategy-benefits">
              <li>Pricing tailored to your business size & goals</li>
              <li>No contracts — cancel anytime</li>
              <li>See exactly how our system works for your industry</li>
              <li>Get a free reputation audit on the call</li>
            </ul>
          </div>
          <div class="strategy-card-wrapper" data-aos="fade-left">
            <div class="strategy-card">
              <div class="strategy-icon">📅</div>
              <h3>Free Strategy Call</h3>
              <p>Talk directly with our team. We'll learn about your business and show you exactly what results to expect.</p>
              <a href="https://calendly.com/digitaldominant/30min?month=2026-06" target="_blank" class="btn btn-primary" style="width: 100%; text-align: center;">Book Your Free Call -></a>
              <span class="strategy-subtext">No commitment. No pressure. Just results.</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    '''
idx_content = idx_content[:pricing_start] + pricing_new + idx_content[pricing_end:]

# 2. Testimonials Marquee
test_start = idx_content.find('<!-- Testimonials Section -->')
test_end = idx_content.find('<!-- Portfolio Preview Section -->')
if test_end == -1:
    test_end = idx_content.find('<!-- Trades We Serve Section -->')

marquee_items = ''
for r in reviews[:7]: # using 7 reviews for smooth scroll
    marquee_items += f'''
            <div class="marquee-card">
              <div class="stars">★★★★★</div>
              <div class="quote-icon">"</div>
              <p>"{r[2]}"</p>
              <div class="author">
                <h4>{r[0]}</h4>
                <span>{r[1]}</span>
              </div>
            </div>'''

test_new = f'''<!-- Testimonials Section -->
    <section class="testimonials-marquee-section" id="testimonials">
      <div class="container text-center" data-aos="fade-up">
        <h2 class="section-title" style="color: #ffffff;">Trusted by <span style="color: #3b82f6;">500+ Local Businesses</span></h2>
        <p class="section-subtitle" style="color: #9ca3af; margin-bottom: 3rem;">Real results from real business owners across the country.</p>
      </div>
      <div class="marquee-container">
        <div class="marquee-track">{marquee_items}{marquee_items}
        </div>
      </div>
    </section>

    '''
idx_content = idx_content[:test_start] + test_new + idx_content[test_end:]

# 3. Trades Section
trades_start = idx_content.find('<!-- Trades We Serve Section -->')
trades_end = idx_content.find('<!-- Core Value Propositions Section -->')

trades_cards = [
  ('HVAC', '🔥'), ('Roofing', '🏠'), ('Dog Grooming', '🐕'), ('Plumbing', '🔧'), 
  ('Electrical', '⚡'), ('Landscaping', '✂️'), ('Dental', '🦷'), 
  ('Auto Repair', '🚗'), ('Cleaning', '✨'), ('Moving', '🚚')
]
trades_html = ''
for t in trades_cards:
    trades_html += f'''
          <div class="service-card">
            <div class="service-icon" style="color: #3b82f6; font-size: 2.5rem; margin-bottom: 1rem;">{t[1]}</div>
            <h4 style="color: #000;">{t[0]}</h4>
          </div>'''

trades_new = f'''<!-- Trades We Serve Section -->
    <section class="trades-grid-section" id="trades">
      <div class="container text-center" data-aos="fade-up">
        <h2 class="section-title">Built for <span style="color: #3b82f6;">Local Service Businesses</span></h2>
        <div class="service-cards-grid">{trades_html}
        </div>
      </div>
    </section>

    '''
idx_content = idx_content[:trades_start] + trades_new + idx_content[trades_end:]

with open("index.html", "w", encoding="utf-8") as f:
    f.write(idx_content)

# Update CSS
css_append = '''
/* Strategy Call Section */
.strategy-call-section {
  padding: 6rem 0;
  background-color: #ffffff;
}

.strategy-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4rem;
  align-items: center;
}

.strategy-benefits {
  list-style: none;
  padding: 0;
  margin-top: 2rem;
}

.strategy-benefits li {
  margin-bottom: 1rem;
  font-size: 1.1rem;
  color: var(--text-secondary);
  display: flex;
  align-items: flex-start;
}

.strategy-benefits li::before {
  content: '✓';
  color: #3b82f6;
  margin-right: 12px;
  font-weight: bold;
  font-size: 1.2rem;
}

.strategy-card-wrapper {
  perspective: 1000px;
}

.strategy-card {
  background-color: #ffffff;
  padding: 3rem;
  border-radius: 16px;
  box-shadow: 0 20px 40px rgba(0,0,0,0.08);
  border: 1px solid var(--border-color);
  text-align: center;
}

.strategy-icon {
  font-size: 3rem;
  color: #3b82f6;
  margin-bottom: 1rem;
}

.strategy-card h3 {
  font-size: 1.8rem;
  margin-bottom: 1rem;
  color: var(--text-primary);
}

.strategy-card p {
  color: var(--text-secondary);
  margin-bottom: 2rem;
  font-size: 1.05rem;
}

.strategy-subtext {
  display: block;
  margin-top: 1rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

/* Testimonials Marquee Section */
.testimonials-marquee-section {
  padding: 6rem 0;
  background-color: #0f172a; /* Dark theme */
  overflow: hidden;
}

.marquee-container {
  width: 100%;
  overflow: hidden;
  position: relative;
  padding: 2rem 0;
}

.marquee-track {
  display: flex;
  width: calc(400px * 14);
  animation: scroll 40s linear infinite;
  gap: 2rem;
}

.marquee-container:hover .marquee-track {
  animation-play-state: paused;
}

@keyframes scroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(calc(-400px * 7 - 14rem)); }
}

.marquee-card {
  width: 400px;
  background-color: #1e293b;
  border-radius: 12px;
  padding: 2rem;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  box-shadow: 0 10px 20px rgba(0,0,0,0.2);
}

.marquee-card .stars {
  color: #f59e0b;
  font-size: 1.2rem;
  margin-bottom: 1rem;
  letter-spacing: 2px;
}

.marquee-card .quote-icon {
  font-size: 3rem;
  color: #3b82f6;
  opacity: 0.5;
  line-height: 0.5;
  margin-bottom: 1rem;
  font-family: serif;
}

.marquee-card p {
  color: #e2e8f0;
  font-size: 1rem;
  line-height: 1.6;
  flex-grow: 1;
  margin-bottom: 2rem;
}

.marquee-card .author h4 {
  color: #ffffff;
  margin-bottom: 0.25rem;
  font-size: 1.1rem;
}

.marquee-card .author span {
  color: #94a3b8;
  font-size: 0.9rem;
}

/* Trades Grid Section */
.trades-grid-section {
  padding: 6rem 0;
  background-color: var(--bg-secondary);
}

.service-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
  margin-top: 4rem;
}

.service-card {
  background-color: #ffffff;
  padding: 2rem 1.5rem;
  border-radius: 12px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.05);
  transition: transform 0.3s, box-shadow 0.3s;
  border: 1px solid var(--border-color);
}

.service-card:hover {
  transform: translateY(-5px);
  box-shadow: 0 10px 20px rgba(0,0,0,0.08);
}

.service-card h4 {
  color: var(--text-primary);
  font-size: 1.1rem;
  margin-bottom: 0;
}

@media (max-width: 900px) {
  .strategy-layout {
    grid-template-columns: 1fr;
    gap: 3rem;
  }
}
'''
with open("style.css", "a", encoding="utf-8") as f:
    f.write(css_append)
