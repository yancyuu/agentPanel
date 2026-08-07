#!/usr/bin/env node
// Generate 13 pixel-art character SVGs for digital worker avatars.
// Each character is a 16x16 grid rendered as SVG rectangles.
// Run: node scripts/generate-pixel-avatars.js

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'participant-avatars');

// 13 distinct color palettes (skin, hair, shirt, pants, accent)
const PALETTES = [
  { skin: '#f5c5a3', hair: '#4a3728', shirt: '#4ade80', pants: '#2d4a3e', accent: '#86efac' },
  { skin: '#f5c5a3', hair: '#2c1810', shirt: '#60a5fa', pants: '#1e3a5f', accent: '#93c5fd' },
  { skin: '#d4a574', hair: '#1a0f08', shirt: '#f472b6', pants: '#6b2154', accent: '#f9a8d4' },
  { skin: '#f5c5a3', hair: '#8b4513', shirt: '#fbbf24', pants: '#78350f', accent: '#fde68a' },
  { skin: '#e8b88a', hair: '#0f0f0f', shirt: '#a78bfa', pants: '#3b1f7a', accent: '#c4b5fd' },
  { skin: '#f5c5a3', hair: '#d4a017', shirt: '#f87171', pants: '#7f1d1d', accent: '#fca5a5' },
  { skin: '#d4a574', hair: '#0f0f0f', shirt: '#34d399', pants: '#064e3b', accent: '#6ee7b7' },
  { skin: '#f5c5a3', hair: '#654321', shirt: '#fb923c', pants: '#7c2d12', accent: '#fdba74' },
  { skin: '#e8b88a', hair: '#c0c0c0', shirt: '#818cf8', pants: '#312e81', accent: '#a5b4fc' },
  { skin: '#f5c5a3', hair: '#2c1810', shirt: '#2dd4bf', pants: '#134e4a', accent: '#5eead4' },
  { skin: '#d4a574', hair: '#0f0f0f', shirt: '#e879f9', pants: '#701a75', accent: '#f0abfc' },
  { skin: '#f5c5a3', hair: '#8b4513', shirt: '#4ade80', pants: '#14532d', accent: '#bbf7d0' },
  { skin: '#e8b88a', hair: '#0f0f0f', shirt: '#38bdf8', pants: '#0c4a6e', accent: '#7dd3fc' },
];

// Hair style variations (5 types, cycled)
const HAIR_STYLES = [
  // 0: short crop
  [
    '  XXXX  ',
    ' XXXXXX ',
  ],
  // 1: spiky
  [
    'X X  X X',
    ' XXXXXX ',
  ],
  // 2: long
  [
    'XXXXXXXX',
    'XXXXXXXX',
  ],
  // 3: mohawk
  [
    ' XX XX  ',
    ' XXXXXX ',
  ],
  // 4: bald/rounded
  [
    ' XXXXXX ',
    ' XXXXXX ',
  ],
];

// Accessory variations (per character index)
const ACCESSORIES = [
  null,           // 01: none
  'glasses',      // 02: glasses
  null,           // 03: none
  'hat',          // 04: hat
  null,           // 05: none
  'headband',     // 06: headband
  null,           // 07: none
  'glasses',      // 08: glasses
  null,           // 09: none
  'hat',          // 10: hat
  null,           // 11: none
  'headband',     // 12: headband
  null,           // 13: none
];

function generatePixelCharacter(index) {
  const p = PALETTES[index % PALETTES.length];
  const hairStyle = HAIR_STYLES[index % HAIR_STYLES.length];
  const accessory = ACCESSORIES[index % ACCESSORIES.length];

  const PIXEL = 4; // each "pixel" is 4x4 SVG units
  const W = 16 * PIXEL; // 64
  const H = 16 * PIXEL; // 64

  let rects = '';

  const px = (x, y, color) => {
    rects += `<rect x="${x * PIXEL}" y="${y * PIXEL}" width="${PIXEL}" height="${PIXEL}" fill="${color}"/>`;
  };

  // Background (transparent)
  // No background rects needed

  // Row 0-1: Hair
  for (let row = 0; row < 2; row++) {
    const line = hairStyle[row];
    for (let col = 0; col < 8; col++) {
      if (line[col] === 'X') {
        px(4 + col, row, p.hair);
      }
    }
  }

  // Row 2: Hair sides + forehead
  px(3, 2, p.hair);
  px(4, 2, p.skin);
  px(5, 2, p.skin);
  px(6, 2, p.skin);
  px(7, 2, p.skin);
  px(8, 2, p.skin);
  px(9, 2, p.skin);
  px(10, 2, p.skin);
  px(11, 2, p.hair);

  // Row 3: Face (eyes)
  px(3, 3, p.skin);
  px(4, 3, p.skin);
  px(5, 3, '#1a1a2e'); // left eye
  px(6, 3, p.skin);
  px(7, 3, p.skin);
  px(8, 3, p.skin);
  px(9, 3, '#1a1a2e'); // right eye
  px(10, 3, p.skin);
  px(11, 3, p.skin);

  // Row 4: Face (mouth)
  px(3, 4, p.skin);
  px(4, 4, p.skin);
  px(5, 4, p.skin);
  px(6, 4, p.skin);
  px(7, 4, '#e88b8b'); // mouth
  px(8, 4, p.skin);
  px(9, 4, p.skin);
  px(10, 4, p.skin);
  px(11, 4, p.skin);

  // Row 5: Chin
  px(4, 5, p.skin);
  px(5, 5, p.skin);
  px(6, 5, p.skin);
  px(7, 5, p.skin);
  px(8, 5, p.skin);
  px(9, 5, p.skin);
  px(10, 5, p.skin);

  // Row 6: Neck
  px(6, 6, p.skin);
  px(7, 6, p.skin);
  px(8, 6, p.skin);
  px(9, 6, p.skin);

  // Row 7-9: Shirt body
  for (let row = 7; row <= 9; row++) {
    for (let col = 4; col <= 11; col++) {
      px(col, row, p.shirt);
    }
    // Shirt detail on row 8
    if (row === 8) {
      px(7, row, p.accent); // button/stripe
    }
  }

  // Row 7: Arms (skin)
  px(3, 7, p.skin); // left arm
  px(12, 7, p.skin); // right arm

  // Row 8: Arms (shirt)
  px(2, 8, p.shirt);
  px(3, 8, p.shirt);
  px(12, 8, p.shirt);
  px(13, 8, p.shirt);

  // Row 9: Hands
  px(2, 9, p.skin);
  px(3, 9, p.skin);
  px(12, 9, p.skin);
  px(13, 9, p.skin);

  // Row 10-11: Pants
  for (let col = 5; col <= 10; col++) {
    px(col, 10, p.pants);
    px(col, 11, p.pants);
  }

  // Row 12-13: Legs (split)
  px(5, 12, p.pants);
  px(6, 12, p.pants);
  px(7, 12, '#0a0a0f'); // gap
  px(8, 12, '#0a0a0f'); // gap
  px(9, 12, p.pants);
  px(10, 12, p.pants);

  px(5, 13, p.pants);
  px(6, 13, p.pants);
  px(9, 13, p.pants);
  px(10, 13, p.pants);

  // Row 14: Feet
  px(4, 14, '#2a2a3e');
  px(5, 14, '#2a2a3e');
  px(6, 14, '#2a2a3e');
  px(9, 14, '#2a2a3e');
  px(10, 14, '#2a2a3e');
  px(11, 14, '#2a2a3e');

  // Accessories
  if (accessory === 'glasses') {
    // Glasses on face (row 3)
    px(4, 3, '#4a4a6e');  // left frame
    px(6, 3, '#4a4a6e');  // left frame
    px(8, 3, '#4a4a6e');  // bridge
    px(10, 3, '#4a4a6e'); // right frame
  }

  if (accessory === 'hat') {
    // Hat on top (rows -2 to -1, shift everything down or draw above)
    px(3, 0, p.accent);
    px(4, 0, p.accent);
    px(5, 0, p.accent);
    px(6, 0, p.accent);
    px(7, 0, p.accent);
    px(8, 0, p.accent);
    px(9, 0, p.accent);
    px(10, 0, p.accent);
    px(11, 0, p.accent);
    // Brim
    px(2, 1, p.accent);
    px(3, 1, p.accent);
    px(11, 1, p.accent);
    px(12, 1, p.accent);
  }

  if (accessory === 'headband') {
    px(3, 2, p.accent);
    px(11, 2, p.accent);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">
${rects}
</svg>`;
}

// Generate all 13 avatars
for (let i = 0; i < 13; i++) {
  const svg = generatePixelCharacter(i);
  const filename = String(i + 1).padStart(2, '0') + '.svg';
  fs.writeFileSync(path.join(OUT_DIR, filename), svg);
  console.log(`Generated ${filename}`);
}

console.log(`\nDone! 13 pixel art avatars saved to ${OUT_DIR}`);
