const fs = require('fs');
const path = require('path');

const buildsDir = path.join(__dirname, '..', 'builds');

if (!fs.existsSync(buildsDir)) {
    console.error('Builds directory not found.');
    process.exit(1);
}

const files = fs.readdirSync(buildsDir).filter(f => f.endsWith('.html'));

console.log(`Found ${files.length} agents. Starting Neural Patch...`);

files.forEach(file => {
    const filePath = path.join(buildsDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    
    // 1. Remove the modal HTML block
    const modalRegex = /<div id="aon-origin-restore-overlay"[\s\S]*?<\/div>[\s\n]*<\/div>/g;
    content = content.replace(modalRegex, '');
    
    // 2. Remove the line that shows the modal
    const showModalRegex = /document\.getElementById\('aon-origin-restore-overlay'\)\.style\.display = 'flex';/g;
    content = content.replace(showModalRegex, '// SILENT PATCH: Noise suppressed');
    
    // 3. Update the comment to be more premium
    content = content.replace(/console\.warn\('\[AON\] Ignored external noise:', msg\);/g, "console.warn('[AON] Neutralized external interference:', msg);");

    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Patched: ${file}`);
});

console.log('Neural Cleanup Complete. All existing agents are now silent.');
