const fs = require('fs');
const report = fs.readFileSync('Code-Review-Report.md', 'utf-8');
const findingsToCheck = [56, 37, 38, 39, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 61, 62, 63, 64, 67, 68, 73, 75, 81, 82, 83, 84, 85, 86, 87, 88, 65, 66];
let notFixed = [];
findingsToCheck.forEach(num => {
  const regex = new RegExp(`^${num}\\.\\s+\\\`\\[P\\d\\]\\\`\\s+(?!\\*\\*FIXED\\*\\*)`, 'm');
  if (regex.test(report)) {
    notFixed.push(num);
  }
});
console.log('Not marked FIXED:', notFixed);
