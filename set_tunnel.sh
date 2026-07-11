#!/bin/bash
set -e

# ==========================================
# CONFIGURATION VALUES
# ==========================================
HOST_A_PUBLIC_IP="157.250.207.30"      # la (needmonero.com)
HOST_B_PUBLIC_IP="208.87.135.9"        # snode (snode.joshjames.site)
HOST_B_SSH="epic@snode.joshjames.site"

# New isolated private subnet endpoints
WG_IP_A="10.100.0.1/24"                 # la internal IP
WG_IP_B="10.100.0.2/24"                 # snode internal IP
WG_PORT="51821"                         # Unique port for wg1

echo "=== Step 1: Generating WireGuard Keys locally on 'la' ==="
mkdir -p ./wg1_keys
wg genkey | tee ./wg1_keys/la.key | wg pubkey > ./wg1_keys/la.pub
wg genkey | tee ./wg1_keys/snode.key | wg pubkey > ./wg1_keys/snode.pub

LA_PRIVATE=$(cat ./wg1_keys/la.key)
LA_PUBLIC=$(cat ./wg1_keys/la.pub)
SNODE_PRIVATE=$(cat ./wg1_keys/snode.key)
SNODE_PUBLIC=$(cat ./wg1_keys/snode.pub)

echo "=== Step 2: Writing local config file for 'la' ==="
sudo mkdir -p /etc/wireguard
cat << EOF | sudo tee /etc/wireguard/wg1.conf > /dev/null
[Interface]
PrivateKey = $LA_PRIVATE
Address = $WG_IP_A
ListenPort = $WG_PORT

[Peer]
PublicKey = $SNODE_PUBLIC
Endpoint = ${HOST_B_PUBLIC_IP}:${WG_PORT}
AllowedIPs = 10.100.0.2/32
PersistentKeepalive = 25
EOF

echo "=== Step 3: Pushing installation and config to remote node 'snode' ==="
# Install wireguard on target node, configure interface, and clear transient values safely
ssh -t $HOST_B_SSH "
  sudo apt-get update && sudo apt-get install -y wireguard
  cat << 'EOF2' | sudo tee /etc/wireguard/wg1.conf > /dev/null
[Interface]
PrivateKey = $SNODE_PRIVATE
Address = $WG_IP_B
ListenPort = $WG_PORT

[Peer]
PublicKey = $LA_PUBLIC
Endpoint = ${HOST_A_PUBLIC_IP}:${WG_PORT}
AllowedIPs = 10.100.0.1/32
PersistentKeepalive = 25
EOF2
"

echo "=== Step 4: Activating wg1 interfaces on both nodes ==="
sudo systemctl enable --now wg-quick@wg1
ssh $HOST_B_SSH "sudo systemctl enable --now wg-quick@wg1"

echo "=== Step 5: Verification ==="
echo "Testing tunnel connectivity via cross-ping..."
ping -c 3 10.100.0.2

echo "======================================================="
echo " WireGuard Tunnel successfully established over wg1! "
echo " la: 10.100.0.1 <---> snode: 10.100.0.2 "
echo "======================================================="
rm -rf ./wg1_keys
