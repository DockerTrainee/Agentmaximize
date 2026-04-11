const axios = require('axios');

async function testSynthesis() {
    const goal = "Build a comprehensive travel booking system with a search engine, a flight tracker, and a destination guide.";
    console.log(`[TEST] STARTING MISSION: ${goal}`);

    try {
        const response = await axios.post('http://localhost:3000/orchestrate', { goal });
        if (!response.data.success) throw new Error("INITIAL HANDSHAKE FAILED");

        const jobId = response.data.jobId;
        console.log(`[TEST] JOB ID: ${jobId}. ENTERING POLLING LOOP...`);

        while (true) {
            const statusRes = await axios.get(`http://localhost:3000/job-status/${jobId}`);
            const job = statusRes.data;

            process.stdout.write(`\r[TEST] PROGRESS: [${job.progress}%] [${job.status.toUpperCase()}]`);

            if (job.status === 'completed') {
                console.log("\n[TEST] MISSION SUCCESS! PROJECT ARCHITECTED.");
                process.exit(0);
            }

            if (job.status === 'failed') {
                console.log(`\n[TEST] MISSION FAILED: ${job.error}`);
                job.logs.forEach(log => console.log(`  > ${log}`));
                process.exit(1);
            }

            await new Promise(r => setTimeout(r, 10000));
        }

    } catch (e) {
        console.error(`\n[TEST] CRITICAL TEST ERROR: ${e.message}`);
        process.exit(1);
    }
}

testSynthesis();
