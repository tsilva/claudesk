import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

const CONFIG_DIR = join(homedir(), ".claudesk");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface ClaudeskConfig {
  repos: string;
  repoBlacklistPatterns?: string[];
}

async function readConfig(): Promise<ClaudeskConfig | null> {
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ClaudeskConfig;
  } catch {
    return null;
  }
}

async function saveConfig(config: ClaudeskConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function setupConfig(): Promise<ClaudeskConfig> {
  process.stdout.write("\nWelcome to claudesk!\n\n");
  process.stdout.write("Where are your git repos?\n");

  let reposPath = "";
  while (true) {
    reposPath = await prompt("Path: ");
    if (!reposPath) {
      process.stdout.write("Path cannot be empty. Please try again.\n");
      continue;
    }
    // Expand ~ manually
    if (reposPath.startsWith("~/")) {
      reposPath = join(homedir(), reposPath.slice(2));
    }
    try {
      const s = await stat(reposPath);
      if (!s.isDirectory()) {
        process.stdout.write(`"${reposPath}" is not a directory. Please try again.\n`);
        continue;
      }
      break;
    } catch {
      process.stdout.write(`"${reposPath}" does not exist. Please try again.\n`);
    }
  }

  const config: ClaudeskConfig = { repos: reposPath };
  await saveConfig(config);
  process.stdout.write(`\nConfig saved to ${CONFIG_FILE}\n\n`);
  return config;
}

let cachedReposDir: string | null = null;

export async function getReposDir(): Promise<string> {
  if (cachedReposDir !== null) return cachedReposDir;

  const config = await readConfig();
  if (config?.repos) {
    cachedReposDir = config.repos;
    return cachedReposDir;
  }

  const newConfig = await setupConfig();
  cachedReposDir = newConfig.repos;
  return cachedReposDir;
}

export async function runSetup(): Promise<void> {
  cachedReposDir = null;
  await setupConfig();
}

let cachedBlacklistPatterns: string[] | null = null;

export async function isRepoBlacklisted(repoName: string): Promise<boolean> {
  if (cachedBlacklistPatterns === null) {
    const config = await readConfig();
    cachedBlacklistPatterns = config?.repoBlacklistPatterns ?? [];
  }

  for (const pattern of cachedBlacklistPatterns) {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      if (regex.test(repoName)) return true;
    } else if (repoName === pattern) {
      return true;
    }
  }

  return false;
}
