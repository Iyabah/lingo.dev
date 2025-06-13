import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import {
  gitConfig,
  IntegrationFlow,
  IIntegrationFlowOptions,
} from "./_base";
import i18nCmd from "../../i18n";
import runCmd from "../../run";

function removeFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
  }
}

function getCurrentDirectory(): string {
  return process.cwd();
}

function listDirectory(dirPath: string = "."): string {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    return files
      .map(file => {
        const stats = fs.statSync(path.join(dirPath, file.name));
        const permissions = stats.mode.toString(8).slice(-3);
        const size = stats.size;
        const modified = stats.mtime.toISOString().slice(0, 19).replace('T', ' ');
        return `${file.isDirectory() ? 'd' : '-'}${permissions} ${size.toString().padStart(8)} ${modified} ${file.name}`;
      })
      .join('\n');
  } catch (error) {
    return execSync(os.platform() === 'win32' ? 'dir' : 'ls -la', { 
      encoding: 'utf8',
      cwd: dirPath
    });
  }
}

function escapeShellArg(arg: string): string {
  if (os.platform() === 'win32') {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export class InBranchFlow extends IntegrationFlow {
  async preRun() {
    this.ora.start("Configuring git");
    const canContinue = this.configureGit();
    this.ora.succeed("Git configured");

    return canContinue;
  }

  async run(options: IIntegrationFlowOptions) {
    this.ora.start("Running Lingo.dev");
    await this.runLingoDotDev(options.parallel);
    this.ora.succeed("Done running Lingo.dev");

    removeFile("i18n.cache");

    this.ora.start("Checking for changes");
    const hasChanges = this.checkCommitableChanges();
    this.ora.succeed(hasChanges ? "Changes detected" : "No changes detected");

    if (hasChanges) {
      this.ora.start("Committing changes");
      execSync(`git add .`, { stdio: "inherit" });
      execSync(`git status --porcelain`, { stdio: "inherit" });
      execSync(
        `git commit -m ${escapeShellArg(this.platformKit.config.commitMessage)} --no-verify`,
        {
          stdio: "inherit",
        },
      );
      this.ora.succeed("Changes committed");

      this.ora.start("Pushing changes to remote");
      const currentBranch =
        this.i18nBranchName ?? this.platformKit.platformConfig.baseBranchName;
      execSync(
        `git push origin ${currentBranch} ${options.force ? "--force" : ""}`,
        {
          stdio: "inherit",
        },
      );
      this.ora.succeed("Changes pushed to remote");
    }

    return hasChanges;
  }

  protected checkCommitableChanges() {
    return (
      execSync('git status --porcelain || echo "has_changes"', {
        encoding: "utf8",
      }).length > 0
    );
  }

  private async runLingoDotDev(isParallel?: boolean) {
    try {
      if (!isParallel) {
        await i18nCmd
          .exitOverride()
          .parseAsync(["--api-key", this.platformKit.config.replexicaApiKey], {
            from: "user",
          });
      } else {
        await runCmd
          .exitOverride()
          .parseAsync(["--api-key", this.platformKit.config.replexicaApiKey], {
            from: "user",
          });
      }
    } catch (err: any) {
      if (err.code === "commander.helpDisplayed") return;
      throw err;
    }
  }

  private configureGit() {
    const { processOwnCommits } = this.platformKit.config;
    const { baseBranchName } = this.platformKit.platformConfig;

    this.ora.info(`Current working directory: ${getCurrentDirectory()}`);
    this.ora.info(`Directory contents:\n${listDirectory()}`);

    execSync(`git config --global safe.directory ${process.cwd()}`);

    execSync(`git config user.name "${gitConfig.userName}"`);
    execSync(`git config user.email "${gitConfig.userEmail}"`);

    // perform platform-specific configuration before fetching or pushing to the remote
    this.platformKit?.gitConfig();

    execSync(`git fetch origin ${baseBranchName}`, { stdio: "inherit" });
    execSync(`git checkout ${baseBranchName} --`, { stdio: "inherit" });

    if (!processOwnCommits) {
      const currentAuthor = `${gitConfig.userName} <${gitConfig.userEmail}>`;
      const authorOfLastCommit = execSync(
        `git log -1 --pretty=format:'%an <%ae>'`,
      ).toString();
      if (authorOfLastCommit === currentAuthor) {
        this.ora.warn(
          `The last commit was already made by ${currentAuthor}, so this run will be skipped, as running again would have no effect. See docs: https://docs.lingo.dev/ci-action/overview`,
        );
        return false;
      }
    }

    const workingDir = path.resolve(
      process.cwd(),
      this.platformKit.config.workingDir,
    );
    if (workingDir !== process.cwd()) {
      this.ora.info(
        `Changing to working directory: ${this.platformKit.config.workingDir}`,
      );
      process.chdir(workingDir);
    }

    return true;
  }
}
