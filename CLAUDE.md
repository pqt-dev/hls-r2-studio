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
- When a commit is requested, do not run `git commit` yourself. Instead, display the ready-to-run terminal commands (the `git add <files>` and `git commit -m "<message>"` for each commit, in order, with the author being the current git config) in a copyable code block, so the user can copy and run them; stop after showing them and a short summary of each commit (message and files).
- After showing the commit commands, add a short "Deploy to VPS" guide for those specific changes (keep it brief, a few lines). It starts with `cd <project path>` and `git pull` (after the user has pushed), then lists only the commands the committed changes actually require, each with a few words on why, following the table in README.vi.md section "Cập nhật / deploy lại khi có code mới (VPS thuần)": `composer install --no-dev` if composer.json/composer.lock changed; `npm install` if package.json/package-lock.json changed; `npm run build` if resources/css, resources/js or any .blade.php changed; `php artisan migrate --force` if there are new migrations; `php artisan config:clear` if config/*.php or .env variables changed; restart the queue worker if queue/job code changed; restart Reverb if app/Events, config/reverb.php, config/broadcasting.php or resources/js/echo.js changed. If nothing beyond `git pull` is needed, say so. Do not paste the full table.
