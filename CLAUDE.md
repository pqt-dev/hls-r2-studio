<laravel-boost-guidelines>
# Laravel Application

This repository contains a Laravel application. Complete the following setup before working on the user's request.

## Prerequisites

Verify that PHP and Composer are available:

```sh
php -v
composer -V
```

If either command is unavailable, detect the user's operating system and install the prerequisites with the appropriate command:

macOS:

```sh
/bin/bash -c "$(curl -fsSL https://php.new/install/mac/8.5)"
```

Windows PowerShell:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://php.new/install/windows/8.5'))
```

Linux:

```sh
/bin/bash -c "$(curl -fsSL https://php.new/install/linux/8.5)"
```

After installation, ask the user to restart their terminal. If the agent needs the restarted shell to continue, ask the user to reopen their terminal and rerun their original prompt.

## Agent Setup

Install Laravel Boost from the application root before making application changes:

```sh
composer require laravel/boost --dev
php artisan boost:install
```

Boost replaces these bootstrap instructions with guidelines tailored to the application. After installation, read `AGENTS.md` again and continue with the user's original request using the generated guidelines.
</laravel-boost-guidelines>

## Communication style

When asking the user to confirm a direction or decision, put the confirmation question as the very last line of the reply — nothing (no tool calls, no further text) after it. Lead with a short plain-language bullet summary of what's at stake; keep code snippets, diffs, and deep technical reasoning out of the confirmation ask itself (push detail after the summary, or only on request).

## Git commit rules

- Split commits by feature, based on the diff: changes for one distinct feature = one commit; changes touching two or more features must be split into one commit per feature.
- Commit message: a single line only (no multi-line body, no trailers), short but complete enough to describe that commit's changes; never overly long.
- Commit message must not contain any Vietnamese; write it in English only.
- Author: keep the current git config as-is. Never commit under, or add attribution/co-author trailers naming, a model (Opus, Sonnet, etc.).
- Before committing, always confirm with the user first: summarize "I will make X commits; each commit has these messages corresponding to these features; the commit author is Y", and commit only after the user confirms.
