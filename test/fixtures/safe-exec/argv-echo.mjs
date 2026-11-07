// safe-exec probe: prints JSON {argv, envKeys} — lets tests PROVE argv purity and env scrubbing
const envKeys = Object.keys(process.env).sort();
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), envKeys }));
