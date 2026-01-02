#!/bin/bash
set -e

echo "Starting Tapcart dev session..."
echo "App ID: $APP_ID"
echo "Block Name: $BLOCK_NAME"
echo "TAPCART_API_KEY set: $([ -n "$TAPCART_API_KEY" ] && echo 'yes' || echo 'no')"

# Create project structure
mkdir -p /app/blocks/"$BLOCK_NAME"

# Write tapcart.config.json
echo "{\"appId\": \"$APP_ID\", \"dependencies\": {}}" > /app/tapcart.config.json

# Write package.json
echo '{"name": "tapcart-dev", "version": "1.0.0", "private": true}' > /app/package.json

# Decode and write code.jsx from base64
if [ -n "$CODE_JSX_B64" ]; then
    echo "$CODE_JSX_B64" | base64 -d > /app/blocks/"$BLOCK_NAME"/code.jsx
    echo "Wrote code.jsx"
fi

# Decode and write manifest.json from base64 (optional)
if [ -n "$MANIFEST_JSON_B64" ]; then
    echo "$MANIFEST_JSON_B64" | base64 -d > /app/blocks/"$BLOCK_NAME"/manifest.json
    echo "Wrote manifest.json"
fi

# Create the block using tapcart CLI (creates config.json)
echo "Creating block structure with tapcart CLI..."
cd /app
echo "Running: tapcart block create \"$BLOCK_NAME\""
tapcart block create "$BLOCK_NAME" || echo "tapcart block create failed, will create config.json manually"

# Check if config.json was created, if not create it manually
if [ ! -f "/app/blocks/$BLOCK_NAME/config.json" ]; then
    echo "config.json not found, creating manually..."
    echo '{"name": "'"$BLOCK_NAME"'", "type": "block"}' > /app/blocks/"$BLOCK_NAME"/config.json
    echo "Created config.json manually"
fi

# Re-write code.jsx after block create (it may have been overwritten with template)
if [ -n "$CODE_JSX_B64" ]; then
    echo "$CODE_JSX_B64" | base64 -d > /app/blocks/"$BLOCK_NAME"/code.jsx
    echo "Re-wrote code.jsx"
fi

# Re-write manifest.json if provided
if [ -n "$MANIFEST_JSON_B64" ]; then
    echo "$MANIFEST_JSON_B64" | base64 -d > /app/blocks/"$BLOCK_NAME"/manifest.json
    echo "Re-wrote manifest.json"
fi

# List files for debugging
echo "Files in block directory:"
ls -la /app/blocks/"$BLOCK_NAME"/

echo "Starting dev server on port 5000..."
exec tapcart block dev -b "$BLOCK_NAME" -p 5000
