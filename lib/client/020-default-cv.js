// ------------------------- starter document -------------------------
// A clean A4 starter CV shown when the session has no saved document yet.
// Rendered locally (never saved until the agent writes a real one) so
// the main pane demonstrates the final shape from the first second.
function starterDoc() {
  return [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8">',
    '<title>CV</title>',
    '<style>',
    '@page{size:A4;margin:0}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'html,body{background:#fff}',
    'body{font-family:Georgia,serif;color:#1a1a1a;font-size:11pt;line-height:1.45}',
    '.page{width:210mm;min-height:297mm;padding:18mm 17mm}',
    'h1{font-size:22pt;letter-spacing:.5px;margin-bottom:2mm}',
    '.sub{color:#555;font-size:10pt;margin-bottom:8mm}',
    'h2{font-size:11pt;text-transform:uppercase;letter-spacing:1.2px;border-bottom:1px solid #ccc;padding-bottom:1mm;margin:6mm 0 2.5mm}',
    '.item{margin-bottom:2.5mm}',
    '.row{display:flex;justify-content:space-between}',
    '.muted{color:#666;font-size:9.5pt}',
    'ul{padding-left:5mm}',
    'li{margin-bottom:1mm}',
    '</style></head><body>',
    '<div class="page">',
    '<h1>Your Name</h1>',
    '<div class="sub">your.email@example.com &middot; +1 555 0100 &middot; linkedin.com/in/you &middot; City, Country</div>',
    '<h2>Professional Summary</h2>',
    '<p class="item">A one-paragraph summary tailored to the target role. The agent rewrites this section first to mirror the job post language.</p>',
    '<h2>Experience</h2>',
    '<div class="item"><div class="row"><strong>Senior Something</strong><span class="muted">2022 &ndash; Present</span></div>',
    '<div class="muted">Company Name</div>',
    '<ul><li>Achievement quantified against the job requirements.</li><li>Achievement with numbers.</li></ul></div>',
    '<div class="item"><div class="row"><strong>Something</strong><span class="muted">2019 &ndash; 2022</span></div>',
    '<div class="muted">Earlier Company</div>',
    '<ul><li>Earlier achievement.</li></ul></div>',
    '<h2>Education</h2>',
    '<div class="item"><div class="row"><strong>Degree</strong><span class="muted">2015 &ndash; 2019</span></div><div class="muted">University</div></div>',
    '<h2>Skills</h2>',
    '<p class="item">Skill one &middot; skill two &middot; skill three</p>',
    '</div></body></html>',
  ].join('\n')
}
