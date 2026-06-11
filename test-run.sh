#!/bin/bash

# Define the absolute path to your target test repository
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

# 2. Define the Target Repo and Action Dir relative to the script's location
TARGET_REPO="$SCRIPT_DIR/mock-jira-repo"
ACTION_DIR="$SCRIPT_DIR"

$SCRIPT_DIR/generate-test-repo.sh

echo "Compiling latest Action code..."
npm run build

echo "Executing Action inside: $TARGET_REPO"
cd "$TARGET_REPO" || exit

env \
  "ACTIONS_STEP_DEBUG=true" \
  "INPUT_PREFIX-KEYS=KEY-1,KEY-2,KEY-3,KEY-5" \
  "INPUT_SUFFIX-KEYS=" \
  "INPUT_REGEX-KEYS=" \
  "INPUT_SOURCE-BRANCH=development" \
  "INPUT_TARGET-BRANCH=release" \
  "INPUT_GITHUB-TOKEN=local_test_mode" \
  "INPUT_TEST-WORKFLOW-ID=./test.sh" \
  "GITHUB_REPOSITORY=local/test-repo" \
  node "$ACTION_DIR/dist/index.js"