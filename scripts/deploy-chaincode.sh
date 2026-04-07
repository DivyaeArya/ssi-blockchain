#!/bin/bash
set -e
# ...existing code...
CHANNEL="firefly" # or "firefly" based on your logs
CC_NAME="ssi-contract"
CC_PATH="$HOME/ssi-blockchain/chaincode/ssi-contract"
CC_SEQUENCE=1
VERSION="1.0"

# -------------------------
# Environment checks / defaults
# -------------------------
# Try a commonly used default MSP from fabric-samples test-network if not set
DEFAULT_MSP="$HOME/ssi-blockchain/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
if [ -z "$CORE_PEER_MSPCONFIGPATH" ] && [ -d "$DEFAULT_MSP" ]; then
  export CORE_PEER_MSPCONFIGPATH="$DEFAULT_MSP"
fi

# Verify peer CLI is available
if ! command -v peer >/dev/null 2>&1; then
  echo "ERROR: 'peer' CLI not found in PATH. Source your Fabric env (e.g. set PATH to fabric binaries) or install Fabric binaries."
  echo "Example: export PATH=\$PATH:/path/to/fabric-samples/bin"
  exit 1
fi

# Verify MSP path exists
if [ -z "$CORE_PEER_MSPCONFIGPATH" ] || [ ! -d "$CORE_PEER_MSPCONFIGPATH" ]; then
  echo "ERROR: CORE_PEER_MSPCONFIGPATH is not set or does not exist."
  echo "Current value: '$CORE_PEER_MSPCONFIGPATH'"
  echo "Set it to your admin MSP directory, for example:"
  echo "  export CORE_PEER_MSPCONFIGPATH=\$HOME/ssi-blockchain/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
  echo "Or run the test-network to generate crypto material: cd \$HOME/ssi-blockchain/fabric-samples/test-network && ./network.sh up createChannel"
  exit 1
fi

echo "Using CORE_PEER_MSPCONFIGPATH=$CORE_PEER_MSPCONFIGPATH"

echo ">>> Packaging chaincode..."
cd "$CC_PATH" && npm install
cd "$HOME/ssi-blockchain"
peer lifecycle chaincode package ssi-contract.tar.gz \
  --path "$CC_PATH" --lang node --label "${CC_NAME}_${VERSION}"

echo ">>> Installing on peer0org1..."
peer lifecycle chaincode install ssi-contract.tar.gz
# ...existing code...# Stop the Fabric test-network (from your repo)
cd $HOME/ssi-blockchain/fabric-samples/test-network
./network.sh down

# Optional: list remaining Fabric-related containers
docker ps -a --filter "name=peer" --filter "name=orderer" --filter "name=ca" --filter "name=dev-peer"

# Remove dev chaincode containers and images left by lifecycle/development
docker ps -a | awk '/dev-peer/ {print $1}' | xargs -r docker rm -f
docker images | awk '/dev-peer/ {print $3}' | xargs -r docker rmi -f

# Remove Fabric-related volumes (use carefully)
docker volume ls | awk '/fabric/ {print $2}' | xargs -r docker volume rm

# Aggressive cleanup (warning: removes unused images/volumes/networks)
# docker system prune -a --volumes