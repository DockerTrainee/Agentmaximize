const fs = require('fs');
const path = require('path');

const buildsDir = path.join(__dirname, '..', 'builds');

async function massHeal() {
    const files = fs.readdirSync(buildsDir);
    let patchedCount = 0;

    for (const file of files) {
        if (file.endsWith('.html')) {
            const filePath = path.join(buildsDir, file);
            let content = fs.readFileSync(filePath, 'utf8');

            if (content.includes('http://localhost:3000')) {
                console.log(`Patching ${file}...`);
                // Replace both with and without quotes just to be safe
                content = content.replace(/http:\/\/localhost:3000/g, '');
                fs.writeFileSync(filePath, content, 'utf8');
                patchedCount++;
            }
        }
    }

    console.log(`Mass Repair Complete. Patched ${patchedCount} agents.`);
}

massHeal();
