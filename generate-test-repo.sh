#!/bin/bash

# Dynamically resolve the absolute path to the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
REMOTE_DIR="$SCRIPT_DIR/mock-jira-remote.git"
LOCAL_DIR="$SCRIPT_DIR/mock-jira-repo"

echo "Cleaning up previous test environments..."
rm -rf "$REMOTE_DIR" "$LOCAL_DIR"

# ---------------------------------------------------------
# 1. Create the Fake "Origin" (Bare Repository)
# ---------------------------------------------------------
echo "Initializing fake 'origin' bare repository..."
mkdir -p "$REMOTE_DIR"
git init --bare --initial-branch=release "$REMOTE_DIR"

# ---------------------------------------------------------
# 2. Clone to Local Workspace
# ---------------------------------------------------------
echo "Cloning into local workspace..."
git clone "$REMOTE_DIR" "$LOCAL_DIR"
cd "$LOCAL_DIR" || exit

# Configure local git user to prevent global config interference
git config user.name "Integration Tester"
git config user.email "tester@example.com"

# ---------------------------------------------------------
# 3. Base Branch: release
# ---------------------------------------------------------
echo "Setting up 'release' branch..."
echo "node_modules/" > .gitignore
echo "dist/" >> .gitignore
echo ".DS_Store" >> .gitignore

git add .gitignore
git commit -m "chore: initial commit with .gitignore"

# Push to establish refs/remotes/origin/release
git push origin release

# ---------------------------------------------------------
# 4. Feature Branch: development
# ---------------------------------------------------------
echo "Branching to 'development'..."
git checkout -b development

# Commit 1: KEY-1
echo '#!/bin/bash' > test.sh
echo 'echo "Running tests... Success!"' >> test.sh
echo 'exit 0' >> test.sh
chmod +x test.sh
git add test.sh
git commit -m "KEY-1: Add initial test script (Passes)"

# Commit 2: KEY-2
echo '# Project Readme' > readme.md
git add readme.md
git commit -m "KEY-2: Add project readme"

# Commit 3: KEY-3
echo '#!/bin/bash' > test.sh
echo 'echo "Running tests... Critical Failure!"' >> test.sh
echo 'exit 1' >> test.sh
git add test.sh
git commit -m "KEY-3: Update test script logic (Fails)"

# Commit 4: KEY-4
echo 'Adding some new architectural documentation.' >> readme.md
git add readme.md
git commit -m "KEY-4: Amend readme with architecture notes"

# Commit 5: KEY-5
echo 'Adding deployment instructions.' >> readme.md
git add readme.md
git commit -m "KEY-5: Amend readme with deployment steps"

# Push to establish refs/remotes/origin/development
git push origin development

# ---------------------------------------------------------
# Summary
# ---------------------------------------------------------
echo -e "\n✅ Repository setup complete. Both branches have been pushed to the fake origin."
echo "Git tree showing local and remote tracking branches:"
git log --all --graph --oneline --decorate --color