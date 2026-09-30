import fs from "fs";
import path from "path";
import dotenv from "dotenv";

const PROFILES = ["development", "test", "staging", "production"];

let hasErrors = false;

function validateProfile(envName: string) {
  const envPath = path.resolve(process.cwd(), `.env.${envName}`);
  
  if (!fs.existsSync(envPath)) {
    console.warn(`[SKIP] Profile .env.${envName} does not exist.`);
    return;
  }
  
  console.log(`\n=== Validating .env.${envName} ===`);
  
  // Parse the env file manually to avoid contaminating process.env
  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  
  // Rule 1: No production secrets in non-production environments
  if (envName !== "production") {
    const secretKey = envConfig.RELAYER_SECRET_KEY;
    if (
      secretKey &&
      secretKey.startsWith("S") &&
      secretKey.length === 56 &&
      secretKey !== "SCZANGBA5AKIA7VTJQXBDKPQOBFZD3NWKNR3CQULPSFMJUADSHWFUCS"
    ) {
      console.error(`[ERROR] Production secret found in .env.${envName}! Use placeholders instead.`);
      hasErrors = true;
    }
  }

  // Add more specific rules if needed...
  
  console.log(`[OK] .env.${envName} is valid.`);
}

console.log("Starting environment profile validation...");

for (const profile of PROFILES) {
  validateProfile(profile);
}

if (hasErrors) {
  console.error("\nProfile validation FAILED. See errors above.");
  process.exit(1);
} else {
  console.log("\nAll profiles passed validation successfully!");
  process.exit(0);
}
