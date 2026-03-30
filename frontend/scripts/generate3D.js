const fs = require('fs');
const path = require('path');

const NUM_POINTS = 800;
const outputFilePath = path.join(__dirname, '../src/pages/landing-sections/Landing3DEngine.js');

let lines = [];
lines.push("import React, { useEffect, useRef } from 'react';");
lines.push("");
lines.push("export default function Landing3DEngine() {");
lines.push("  const engineRef = useRef(null);");
lines.push("  useEffect(() => {");
lines.push("    let angle = 0;");
lines.push("    let reqId;");
lines.push("    const animate = () => {");
lines.push("      if(engineRef.current) {");
lines.push("        angle += 0.002;");
lines.push("        engineRef.current.style.transform = 'rotateY(' + angle + 'rad) rotateX(' + (angle * 0.5) + 'rad)';");
lines.push("      }");
lines.push("      reqId = requestAnimationFrame(animate);");
lines.push("    };");
lines.push("    animate();");
lines.push("    return () => cancelAnimationFrame(reqId);");
lines.push("  }, []);");
lines.push("  return (");
lines.push("    <div style={{ perspective: '1200px', width: '100%', height: '500px', display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden', background: '#0b0b0b' }}>");
lines.push("      <div ref={engineRef} style={{ width: '400px', height: '400px', transformStyle: 'preserve-3d', position: 'relative' }}>");
lines.push("        <svg viewBox=\"-200 -200 400 400\" style={{ width: '100%', height: '100%', overflow: 'visible' }}>");

function getPoint(i, num) {
  const phi = Math.acos(1 - 2 * (i + 0.5) / num);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  const r = 160;
  return {
    x: r * Math.cos(theta) * Math.sin(phi),
    y: r * Math.sin(theta) * Math.sin(phi),
    z: r * Math.cos(phi)
  };
}

for (let i = 0; i < NUM_POINTS; i++) {
  const p1 = getPoint(i, NUM_POINTS);
  const p2 = getPoint((i + 5) % NUM_POINTS, NUM_POINTS);
  const p3 = getPoint((i + 13) % NUM_POINTS, NUM_POINTS);
  
  lines.push("          <path d=\"M " + p1.x.toFixed(2) + "," + p1.y.toFixed(2) + " L " + p2.x.toFixed(2) + "," + p2.y.toFixed(2) + " L " + p3.x.toFixed(2) + "," + p3.y.toFixed(2) + " Z\"");
  lines.push("                fill=\"rgba(41,98,255,0.02)\"");
  lines.push("                stroke=\"rgba(41,98,255,0.15)\"");
  lines.push("                strokeWidth=\"1\"");
  lines.push("                style={{ transform: 'translateZ(' + " + p1.z.toFixed(2) + " + 'px)' }} />");
}

lines.push("        </svg>");
lines.push("      </div>");
lines.push("    </div>");
lines.push("  );");
lines.push("}");

fs.writeFileSync(outputFilePath, lines.join('\n'));
console.log('Successfully generated Landing3DEngine.js with', lines.length, 'lines of code.');
