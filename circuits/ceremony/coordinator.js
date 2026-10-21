#!/usr/bin/env node

/**
 * MPC Ceremony Coordinator Server
 *
 * Manages the trusted setup ceremony by:
 * - Maintaining contribution queue
 * - Verifying each contribution
 * - Publishing ceremony transcript
 * - Coordinating multiple contributors
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const snarkjs = require("snarkjs");
const chalk = require("chalk");

const config = require("./config.json");

const app = express();
app.use(express.json({ limit: "500mb" }));
app.use(express.static("public"));

// State management
const state = {
  phase: "SETUP", // SETUP, PHASE1, PHASE2, BEACON, COMPLETED
  currentContributor: null,
  contributionCount: 0,
  queue: [],
  contributions: [],
  startTime: Date.now(),
};

// Ensure transcript directory exists
const transcriptDir = path.join(__dirname, config.transcriptDir);
if (!fs.existsSync(transcriptDir)) {
  fs.mkdirSync(transcriptDir, { recursive: true });
}

// Load existing state if available
const stateFile = path.join(transcriptDir, "coordinator-state.json");
if (fs.existsSync(stateFile)) {
  Object.assign(state, JSON.parse(fs.readFileSync(stateFile, "utf8")));
  console.log(chalk.green("✓ Loaded existing ceremony state"));
}

function saveState() {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// API Endpoints

app.get("/ceremony/status", (req, res) => {
  res.json({
    phase: state.phase,
    contributionCount: state.contributionCount,
    minContributors: config.minContributors,
    queueLength: state.queue.length,
    currentContributor: state.currentContributor,
    ceremony: config.ceremony,
  });
});

app.post("/ceremony/join", (req, res) => {
  const { name, email, pgpKey } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Name and email required" });
  }

  // Generate contributor ID
  const contributorId = crypto.randomBytes(16).toString("hex");

  const contributor = {
    id: contributorId,
    name,
    email,
    pgpKey: pgpKey || null,
    joinedAt: Date.now(),
    position: state.queue.length + 1,
  };

  state.queue.push(contributor);
  saveState();

  console.log(
    chalk.blue(`➕ ${name} joined (position ${contributor.position})`),
  );

  res.json({
    contributorId,
    position: contributor.position,
    estimatedWait: contributor.position * config.contributionTimeout,
  });
});

app.get("/ceremony/current-params", async (req, res) => {
  const { contributorId } = req.query;

  if (!contributorId) {
    return res.status(400).json({ error: "Contributor ID required" });
  }

  // Check if contributor is at front of queue
  if (state.currentContributor !== contributorId) {
    const position = state.queue.findIndex((c) => c.id === contributorId);
    return res.status(403).json({
      error: "Not your turn",
      position: position + 1,
      currentContributor: state.currentContributor,
    });
  }

  try {
    let paramsFile;
    if (state.phase === "PHASE1" || state.phase === "SETUP") {
      // Return current .ptau file
      paramsFile = path.join(
        transcriptDir,
        `phase1_${state.contributionCount}.ptau`,
      );
    } else if (state.phase === "PHASE2") {
      // Return current .zkey file
      paramsFile = path.join(
        transcriptDir,
        `phase2_${state.contributionCount}.zkey`,
      );
    }

    if (!fs.existsSync(paramsFile)) {
      return res.status(404).json({ error: "Parameters file not found" });
    }

    res.download(paramsFile);
  } catch (error) {
    console.error(chalk.red("✗ Error sending parameters:"), error);
    res.status(500).json({ error: "Failed to send parameters" });
  }
});

app.post("/ceremony/contribute", async (req, res) => {
  const { contributorId, contributorName, entropySource } = req.body;

  if (!contributorId || !req.files || !req.files.params) {
    return res.status(400).json({ error: "Missing contribution data" });
  }

  // Verify contributor is current
  if (state.currentContributor !== contributorId) {
    return res.status(403).json({ error: "Not your turn" });
  }

  try {
    const paramsBuffer = req.files.params.data;
    const contributionNum = state.contributionCount + 1;

    console.log(
      chalk.yellow(
        `⏳ Verifying contribution ${contributionNum} from ${contributorName}...`,
      ),
    );

    // Save contribution
    const contributionFile = path.join(
      transcriptDir,
      `${state.phase === "PHASE1" ? "phase1" : "phase2"}_${contributionNum}.${state.phase === "PHASE1" ? "ptau" : "zkey"}`,
    );
    fs.writeFileSync(contributionFile, paramsBuffer);

    // Verify contribution
    const previousFile = path.join(
      transcriptDir,
      `${state.phase === "PHASE1" ? "phase1" : "phase2"}_${state.contributionCount}.${state.phase === "PHASE1" ? "ptau" : "zkey"}`,
    );

    let verification;
    if (state.phase === "PHASE1") {
      verification = await snarkjs.powersOfTau.verify(contributionFile);
    } else {
      verification = await snarkjs.zKey.verifyFromR1cs(
        config.circuitPath.replace(".circom", ".r1cs"),
        previousFile,
        contributionFile,
      );
    }

    if (!verification) {
      console.log(chalk.red(`✗ Contribution verification failed`));
      fs.unlinkSync(contributionFile);
      return res
        .status(400)
        .json({ error: "Contribution verification failed" });
    }

    // Record contribution
    const contribution = {
      num: contributionNum,
      contributor: {
        id: contributorId,
        name: contributorName,
      },
      entropySource,
      timestamp: Date.now(),
      fileHash: crypto.createHash("sha256").update(paramsBuffer).digest("hex"),
    };

    state.contributions.push(contribution);
    state.contributionCount++;

    // Remove contributor from queue
    state.queue.shift();

    // Set next contributor
    if (state.queue.length > 0) {
      state.currentContributor = state.queue[0].id;
    } else {
      state.currentContributor = null;
    }

    saveState();

    console.log(
      chalk.green(`✓ Contribution ${contributionNum} verified and accepted`),
    );
    console.log(chalk.gray(`  Hash: ${contribution.fileHash}`));

    res.json({
      success: true,
      contributionNum,
      fileHash: contribution.fileHash,
      nextContributor: state.currentContributor,
    });

    // Check if we should advance phase
    if (state.contributionCount >= config.minContributors) {
      if (state.phase === "PHASE1") {
        console.log(
          chalk.green.bold(
            "\n🎉 Phase 1 complete! Transitioning to Phase 2...\n",
          ),
        );
        transitionToPhase2();
      } else if (state.phase === "PHASE2") {
        console.log(
          chalk.green.bold(
            "\n🎉 Phase 2 complete! Ready for random beacon...\n",
          ),
        );
        state.phase = "BEACON";
        saveState();
      }
    }
  } catch (error) {
    console.error(chalk.red("✗ Error processing contribution:"), error);
    res.status(500).json({ error: "Failed to process contribution" });
  }
});

async function transitionToPhase2() {
  try {
    console.log(chalk.yellow("⏳ Preparing Phase 2..."));

    // Apply beacon to Phase 1
    const phase1Final = path.join(
      transcriptDir,
      `phase1_${state.contributionCount}.ptau`,
    );
    const phase1Beacon = path.join(transcriptDir, "phase1_beacon.ptau");

    await snarkjs.powersOfTau.beacon(
      phase1Final,
      phase1Beacon,
      "ZK-VOTE",
      10,
      crypto.randomBytes(32).toString("hex"),
    );

    // Prepare Phase 2
    const phase2Initial = path.join(transcriptDir, "phase2_0.zkey");
    await snarkjs.zKey.newZKey(
      config.circuitPath.replace(".circom", ".r1cs"),
      phase1Beacon,
      phase2Initial,
    );

    state.phase = "PHASE2";
    state.contributionCount = 0;
    state.contributions = [];

    // Notify all queued contributors
    if (state.queue.length > 0) {
      state.currentContributor = state.queue[0].id;
    }

    saveState();

    console.log(chalk.green("✓ Phase 2 ready for contributions"));
  } catch (error) {
    console.error(chalk.red("✗ Error transitioning to Phase 2:"), error);
  }
}

app.get("/ceremony/transcript", (req, res) => {
  const transcript = {
    ceremony: config.ceremony,
    phase: state.phase,
    totalContributions: state.contributionCount,
    contributions: state.contributions,
    startTime: state.startTime,
    completedTime: state.phase === "COMPLETED" ? Date.now() : null,
  };

  res.json(transcript);
});

app.get("/ceremony/download/:filename", (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(transcriptDir, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(filepath);
});

// Start server
const PORT = config.coordinatorPort || 3000;

app.listen(PORT, () => {
  console.log(
    chalk.blue.bold("\n╔══════════════════════════════════════════╗"),
  );
  console.log(chalk.blue.bold("║  ZK-VOTE MPC Ceremony Coordinator        ║"));
  console.log(
    chalk.blue.bold("╚══════════════════════════════════════════╝\n"),
  );
  console.log(chalk.white(`Server running on port ${PORT}`));
  console.log(chalk.white(`Phase: ${state.phase}`));
  console.log(
    chalk.white(
      `Contributions: ${state.contributionCount}/${config.minContributors}`,
    ),
  );
  console.log(chalk.white(`Queue: ${state.queue.length} contributors\n`));
  console.log(chalk.gray(`Transcript directory: ${transcriptDir}`));
  console.log(chalk.gray(`API: http://localhost:${PORT}/ceremony/\n`));
});
