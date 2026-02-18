import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const POWERSHELL_COMPLETION = `
# VMC PowerShell Tab Completion
Register-ArgumentCompleter -CommandName vmc -Native -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $commands = @(
        'snapshot', 'branch', 'list', 'sessions', 'tree',
        'info', 'delete', 'export', 'import', 'config', 'help'
    )

    $tokens = $commandAst.ToString().Split(' ')
    $currentCommand = if ($tokens.Length -gt 1) { $tokens[1] } else { '' }

    # Complete subcommands
    if ($tokens.Length -le 2) {
        $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
        return
    }

    # Complete options per command
    $opts = switch ($currentCommand) {
        'snapshot'  { @('--session', '--latest', '--description', '--tags', '-s', '-d', '-t') }
        'branch'    { @('--name', '--skip-launch', '--dry-run', '-n') }
        'sessions'  { @('--project', '--sort', '--json', '--all', '-p') }
        'list'      { @('--tag', '--sort', '--json') }
        'tree'      { @('--depth', '--json') }
        'delete'    { @('--force', '-f') }
        'export'    { @('--output', '-o') }
        'import'    { @('--rename', '--force') }
        default     { @() }
    }

    # Complete session IDs after --session or -s
    $prevToken = if ($tokens.Length -gt 2) { $tokens[$tokens.Length - 2] } else { '' }
    if ($prevToken -in @('--session', '-s')) {
        try {
            $sessions = (vmc sessions --json 2>$null | ConvertFrom-Json) | ForEach-Object { $_.sessionId }
            $sessions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
        } catch {}
        return
    }

    # For commands that take snapshot names, complete from vmc list
    if ($currentCommand -in @('branch', 'info', 'delete', 'export') -and $tokens.Length -eq 3) {
        try {
            $snapshots = (vmc list --json 2>$null | ConvertFrom-Json) | ForEach-Object { $_.name }
            $snapshots | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
        } catch {}
        return
    }

    $opts | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
`.trim();

const BASH_COMPLETION = `
# VMC Bash Tab Completion
_vmc_completions() {
    local cur prev commands
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    commands="snapshot branch list sessions tree info delete export import config help"

    if [ $COMP_CWORD -eq 1 ]; then
        COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
        return
    fi

    # Complete session IDs after --session or -s
    if [ "$prev" = "--session" ] || [ "$prev" = "-s" ]; then
        local ids=$(vmc sessions --json 2>/dev/null | grep -o '"sessionId":"[^"]*"' | cut -d'"' -f4)
        COMPREPLY=( $(compgen -W "$ids" -- "$cur") )
        return
    fi

    local cmd="\${COMP_WORDS[1]}"
    case "$cmd" in
        snapshot)  COMPREPLY=( $(compgen -W "--session --latest --description --tags -s -d -t" -- "$cur") ) ;;
        branch)    COMPREPLY=( $(compgen -W "--name --skip-launch --dry-run -n" -- "$cur") ) ;;
        sessions)  COMPREPLY=( $(compgen -W "--project --sort --json --all -p" -- "$cur") ) ;;
        list)      COMPREPLY=( $(compgen -W "--tag --sort --json" -- "$cur") ) ;;
        tree)      COMPREPLY=( $(compgen -W "--depth --json" -- "$cur") ) ;;
        delete)    COMPREPLY=( $(compgen -W "--force -f" -- "$cur") ) ;;
        export)    COMPREPLY=( $(compgen -W "--output -o" -- "$cur") ) ;;
        import)    COMPREPLY=( $(compgen -W "--rename --force" -- "$cur") ) ;;
    esac
}
complete -F _vmc_completions vmc
`.trim();

export function registerCompletionsCommand(program: Command): void {
  program
    .command('completions [shell]')
    .description('Install or output shell completion script (powershell, bash)')
    .option('--install', 'Install completions to your shell profile')
    .action(async (shell: string | undefined, opts: { install?: boolean }) => {
      const detected = shell || (process.platform === 'win32' ? 'powershell' : 'bash');

      if (opts.install) {
        await installCompletions(detected);
        return;
      }

      switch (detected.toLowerCase()) {
        case 'powershell':
        case 'pwsh':
          console.log(POWERSHELL_COMPLETION);
          break;
        case 'bash':
          console.log(BASH_COMPLETION);
          break;
        default:
          console.error(`Unsupported shell: ${detected}. Use: powershell, bash`);
          process.exit(1);
      }
    });
}

async function installCompletions(shell: string): Promise<void> {
  switch (shell.toLowerCase()) {
    case 'powershell':
    case 'pwsh': {
      // PowerShell profile path (differs by platform)
      const profileDir = process.platform === 'win32'
        ? path.join(os.homedir(), 'Documents', 'WindowsPowerShell')
        : path.join(os.homedir(), '.config', 'powershell');
      const profilePath = process.platform === 'win32'
        ? path.join(profileDir, 'Microsoft.PowerShell_profile.ps1')
        : path.join(profileDir, 'profile.ps1');

      await fs.mkdir(profileDir, { recursive: true });

      // Check if already installed
      try {
        const existing = await fs.readFile(profilePath, 'utf-8');
        if (existing.includes('VMC PowerShell Tab Completion')) {
          console.log('VMC completions already installed in $PROFILE');
          return;
        }
      } catch {
        // Profile doesn't exist yet
      }

      await fs.appendFile(profilePath, '\n' + POWERSHELL_COMPLETION + '\n');
      console.log(`Completions installed to ${profilePath}`);
      console.log('Restart your terminal or run:  . $PROFILE');
      break;
    }
    case 'bash': {
      const bashrc = path.join(os.homedir(), '.bashrc');

      try {
        const existing = await fs.readFile(bashrc, 'utf-8');
        if (existing.includes('VMC Bash Tab Completion')) {
          console.log('VMC completions already installed in ~/.bashrc');
          return;
        }
      } catch {
        // .bashrc doesn't exist yet
      }

      await fs.appendFile(bashrc, '\n' + BASH_COMPLETION + '\n');
      console.log(`Completions installed to ${bashrc}`);
      console.log('Restart your terminal or run:  source ~/.bashrc');
      break;
    }
    default:
      console.error(`Unsupported shell: ${shell}. Use: powershell, bash`);
      process.exit(1);
  }
}
