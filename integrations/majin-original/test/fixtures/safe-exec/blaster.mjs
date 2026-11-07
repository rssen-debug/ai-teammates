// blaster: floods stdout — maxBuffer/truncation evidence probe
for (let i = 0; i < 200; i++) process.stdout.write("x".repeat(1000));
