# Bunim - Nim Package Manager

Bunim is a modern package manager for the Nim programming language, built with Bun and TypeScript.

> **Note:** Bunim is not meant to replace Nimble. It is intended as an alternative tool for specific use cases. By default, it downloads tar.gz archives from GitHub for faster installations.

## Features

- **Fast**: Built with Bun, the fast JavaScript runtime
- **Simple**: Easy-to-use CLI interface
- **Dependency Resolution**: Automatically resolves and installs dependencies
- **Nimble Compatible**: Uses the same nimble file format as the official Nimble package manager
- **Package Management**: List installed packages with detailed information
- **Package Deduplication**: Remove duplicate packages to save disk space

## Installation

```bash
bun add -g https://github.com/bung87/bunim
```

## Quick Start

```bash
# Initialize a new Nim project
bunim init

# Install dependencies
bunim install

# List installed packages
bunim list
```

## Commands

### `bunim init`

Initialize a new Nim project by creating a `package.nimble` file in the current directory.

```bash
bunim init
```

### `bunim install`

Install all dependencies listed in the `package.nimble` file.

```bash
# Install globally (default)
bunim install

# Install locally in project
bunim install --localdeps

# Install from GitHub
bunim install https://github.com/user/repo

# Install using git clone
bunim install https://github.com/user/repo --git
```

### `bunim list`

Display installed packages with various options.

```bash
# Basic list
bunim list

# Detailed view with size, path, and install date
bunim list --detailed

# List local project packages
bunim list --localdeps

# Sort options
bunim list --sort name      # Sort by name (default)
bunim list --sort version   # Sort by version
bunim list --sort size      # Sort by package size
bunim list --sort date      # Sort by install date
```

### `bunim search`

Search for packages.

```bash
bunim search <query>
```

### `bunim dedupe`

Remove duplicate packages, keeping only the highest version.

```bash
# Preview what would be removed (safe)
bunim dedupe --dry-run

# Remove duplicate packages
bunim dedupe

# Dedupe local project packages
bunim dedupe --localdeps
```

## Global vs Local Installation

By default, packages are installed globally in `~/.nimble/pkgs2`. Use `--localdeps` to install packages locally in your project.

```bash
# Global installation (default)
bunim install
bunim list
bunim dedupe

# Local installation
bunim install --localdeps
bunim list --localdeps
bunim dedupe --localdeps
```
