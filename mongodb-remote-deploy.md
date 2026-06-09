# Connecting to a Remote MongoDB from OpenShift — api-test

This guide covers how to connect the api-test application running on an OpenShift cluster to a MongoDB instance running on a remote machine at `192.168.1.25`.

The app already reads its connection string from `application.properties` via `dotenv`, so the app code requires no changes. The work is entirely in configuration and network setup.

---

## Step 1 — Update application.properties

Edit `application.properties` locally to point at the remote MongoDB host:

```properties
# ─── Application Configuration ───────────────────────────────────────────────
PORT=3000
NODE_ENV=DEV
MONGO_URI=mongodb://root:example@192.168.1.25:27017/api-test?authSource=admin
```

---

## Step 2 — Re-apply the OpenShift Secret

The config is stored as a Secret on the cluster. Push the updated file:

```bash
oc create secret generic api-test-config \
  --from-file=application.properties=./application.properties \
  --dry-run=client -o yaml | oc apply -f -
```

Restart the deployment to pick up the new value:

```bash
oc rollout restart deployment/api-test
```

---

## Step 3 — Verify network reachability

Before the app can connect, the OpenShift pods must be able to reach `192.168.1.25:27017` over the network. Determine which scenario applies to your setup.

### Test connectivity from inside a pod

Run a quick TCP probe from within the cluster to confirm reachability:

```bash
oc run net-test --image=busybox --rm -it --restart=Never -- \
  nc -zv 192.168.1.25 27017
```

- `Connection to 192.168.1.25 27017 port [tcp] succeeded` — reachable, proceed to Step 5
- `nc: can't connect` or timeout — not reachable, follow the relevant scenario below

---

## Scenario A — Cluster is on the same LAN (on-prem / bare-metal)

If your OpenShift nodes are on the same `192.168.1.x` subnet as the MongoDB machine, pods can reach the IP directly. No extra OpenShift configuration is needed.

Simply complete Steps 1–2 and verify with the connectivity test above. If the test passes, the app is ready.

**Ensure MongoDB is listening on all interfaces** on the remote machine. Check `/etc/mongod.conf` (or the Docker container config):

```yaml
net:
  bindIp: 0.0.0.0   # listen on all interfaces, not just 127.0.0.1
  port: 27017
```

If running MongoDB in Docker on `192.168.1.25`:
```bash
docker run -d \
  --name mongo \
  -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=root \
  -e MONGO_INITDB_ROOT_PASSWORD=example \
  mongo:4.4
```

The `-p 27017:27017` flag binds the port to all host interfaces, making it reachable from the network.

---

## Scenario B — Pods cannot reach the IP directly

If the connectivity test fails but the cluster nodes should be able to reach `192.168.1.25` (e.g. routing or firewall issue), create an OpenShift `Service` + `Endpoints` object. This gives pods a stable in-cluster DNS name that routes to the external IP.

### 1. Create a headless Service

```bash
oc create -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: remote-mongodb
  namespace: api-test
spec:
  ports:
    - port: 27017
      targetPort: 27017
EOF
```

### 2. Create an Endpoints object pointing at the remote IP

```bash
oc create -f - <<EOF
apiVersion: v1
kind: Endpoints
metadata:
  name: remote-mongodb
  namespace: api-test
subsets:
  - addresses:
      - ip: 192.168.1.25
    ports:
      - port: 27017
EOF
```

### 3. Update application.properties to use the in-cluster DNS name

```properties
MONGO_URI=mongodb://root:example@remote-mongodb:27017/api-test?authSource=admin
```

### 4. Re-apply the secret and restart

```bash
oc create secret generic api-test-config \
  --from-file=application.properties=./application.properties \
  --dry-run=client -o yaml | oc apply -f -

oc rollout restart deployment/api-test
```

> **Advantage of this approach:** if the MongoDB IP changes in the future, you only update the `Endpoints` object — the app config (`remote-mongodb`) stays the same.

To update the Endpoints IP later:
```bash
oc patch endpoints remote-mongodb --type=json \
  -p='[{"op":"replace","path":"/subsets/0/addresses/0/ip","value":"<new-ip>"}]'
```

---

## Scenario C — Cloud-hosted cluster (192.168.1.25 is a private LAN IP)

A cloud-hosted OpenShift cluster (AWS, Azure, GCP, ROSA, ARO, etc.) cannot reach a private `192.168.1.x` address without a network tunnel. Options:

| Option | Description |
|---|---|
| **Site-to-site VPN** | Connect your LAN to the cloud cluster's VPC/VNet. Most reliable for on-prem to cloud. |
| **WireGuard / OpenVPN tunnel** | Lightweight tunnel from a machine on your LAN to the cluster network. |
| **MongoDB Atlas** | Migrate to a cloud-hosted MongoDB with a public endpoint. Free tier available. |
| **Public IP + firewall rules** | Expose port 27017 on a public IP, restrict access to the cluster's egress IP range. Not recommended without TLS. |

---

## Step 4 — Confirm the connection in logs

After restarting, check the application logs:

```bash
oc logs -f deployment/api-test | grep -i mongo
```

**Success:**
```
INFO  MongoDB connected uri=mongodb://root:example@192.168.1.25:27017/api-test?authSource=admin
```

**Failure:**
```
ERROR MongoDB connection failed: connect ECONNREFUSED 192.168.1.25:27017
ERROR MongoDB connection failed: connection timed out
```

If connection fails, work through the checklist below.

---

## Troubleshooting checklist

| Check | Command / Action |
|---|---|
| MongoDB is running on the remote machine | `docker ps` or `systemctl status mongod` on `192.168.1.25` |
| MongoDB is bound to `0.0.0.0`, not `127.0.0.1` | Check `bindIp` in `/etc/mongod.conf` or Docker port binding |
| Port 27017 is open in the firewall on the remote machine | `sudo firewall-cmd --list-ports` or `ufw status` |
| Cluster nodes can reach the remote IP | `oc run net-test --image=busybox --rm -it --restart=Never -- nc -zv 192.168.1.25 27017` |
| Credentials are correct | Connect manually: `mongosh mongodb://root:example@192.168.1.25:27017 --authenticationDatabase admin` |
| Secret was re-applied after the change | `oc get secret api-test-config -o yaml` and check the data field |
| Deployment was restarted after secret update | `oc rollout restart deployment/api-test` |

---

*eat, sleep, automate — by eazyt*
