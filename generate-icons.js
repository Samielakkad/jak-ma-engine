// One-time script to generate PNG icons from icon.svg
const sharp = require('sharp');
const path = require('path');
const publicDir = path.join(__dirname, 'public');

async function generate() {
  const svg = path.join(publicDir, 'icon.svg');
  await sharp(svg).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'));
  console.log('✅ icon-192.png generated');
  await sharp(svg).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'));
  console.log('✅ icon-512.png generated');
}

generate().catch(console.error);
