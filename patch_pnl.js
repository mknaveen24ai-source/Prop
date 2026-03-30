const fs = require('fs');
let file = fs.readFileSync('backend/routes/trades.js', 'utf8');
file = file.replace(/calculatePnL\(([^)]+)\)/g, (match, args) => {
  if (args.includes('commission')) return match;
  if (match.includes('function ')) return match;
  if (args.includes('calculatePnL')) return match;
  
  let commissionArg = '0';
  if (args.includes('trade.direction')) commissionArg = 'parseFloat(trade.commission || 0)';
  else if (args.includes('t.direction')) commissionArg = 'parseFloat(t.commission || 0)';

  return `calculatePnL(${args}, ${commissionArg})`;
});
fs.writeFileSync('backend/routes/trades.js', file);
console.log('trades.js patched!');

let file2 = fs.readFileSync('backend/challengeEngine.js', 'utf8');
file2 = file2.replace(/calculatePnL\(([^)]+)\)/g, (match, args) => {
  if (args.includes('commission')) return match;
  if (match.includes('function ')) return match;
  if (args.includes('calculatePnL')) return match;
  
  let commissionArg = '0';
  if (args.includes('trade.direction')) commissionArg = 'parseFloat(trade.commission || 0)';
  else if (args.includes('t.direction')) commissionArg = 'parseFloat(t.commission || 0)';

  return `calculatePnL(${args}, ${commissionArg})`;
});
fs.writeFileSync('backend/challengeEngine.js', file2);
console.log('challengeEngine.js patched!');
