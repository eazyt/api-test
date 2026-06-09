# OpenShift Deployment Guide — api-test

This guide deploys the api-test application to OpenShift using **Source-to-Image (S2I)** — OpenShift's native build strategy. No Dockerfile is required. OpenShift pulls the source code directly from a Git repository, builds the container image using a Node.js builder image, and deploys it automatically.

---

## Prerequisites

### Tools required on your machine

| Tool | Purpose |
|---|---|
| `oc` CLI | OpenShift command line client — must be logged in to your cluster |
| `git` | Source code must be in a Git repository (GitHub, GitLab, Gitea, etc.) |

Log in to your cluster before starting:
```bash
oc login https://<your-cluster-api-url> --token=<your-token>
```

### Source code requirement

S2I builds pull code from a Git repository. Push your project to a Git remote before proceeding:

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/<your-username>/api-test.git
git push -u origin main
```

> Ensure `application.properties` is listed in `.gitignore` — it contains credentials and must not be committed. Configuration is injected at runtime via a Secret (see Step 4).

### On the cluster

- A project/namespace to deploy into
- Access to the OpenShift internal image registry (available by default)
- The `nodejs` S2I builder image available in the cluster catalog (available by default on all OpenShift clusters)

---

## Step 1 — Create a project

```bash
oc new-project api-test
```

---

## Step 2 — Deploy using S2I

The `oc new-app` command with a Git URL triggers an S2I build. OpenShift detects the `package.json` and automatically selects the Node.js builder image.

```bash
oc new-app nodejs~https://github.com/<your-username>/api-test.git \
  --name=api-test \
  --context-dir=/
```

What this does:
- Creates a **BuildConfig** — defines how to build the image from source using the `nodejs` S2I builder
- Creates an **ImageStream** — tracks built image versions
- Creates a **Deployment** — runs the application pods
- Creates a **Service** — exposes the app internally on port 3000

### Building from a private repository

If your repository is private, create a deploy key secret first:

```bash
oc create secret generic git-secret \
  --from-literal=username=<git-username> \
  --from-literal=password=<git-token>

oc new-app nodejs~https://github.com/<your-username>/api-test.git \
  --name=api-test \
  --source-secret=git-secret
```

### Specifying a Node.js version

To pin a specific Node.js builder version:

```bash
oc new-app nodejs:20~https://github.com/<your-username>/api-test.git \
  --name=api-test
```

Check available Node.js builder versions on your cluster:
```bash
oc get imagestreams -n openshift | grep nodejs
```

---

## Step 3 — Monitor the build

S2I runs the build inside a pod. Follow the build logs to confirm it completes successfully:

```bash
# Watch build progress
oc logs -f buildconfig/api-test

# List all builds
oc get builds

# Check build status
oc describe build api-test-1
```

A successful build ends with:
```
Push successful
```

Once the build is pushed, OpenShift automatically deploys the new image.

---

## Step 4 — Store configuration as a Secret

`application.properties` was excluded from the repository. Create it as an OpenShift Secret so it is mounted into the running container at the path the app expects (`/opt/app-root/src/application.properties`).

```bash
oc create secret generic api-test-config \
  --from-file=application.properties=./application.properties
```

Mount it into the deployment:

```bash
oc set volume deployment/api-test \
  --add \
  --name=config \
  --type=secret \
  --secret-name=api-test-config \
  --mount-path=/opt/app-root/src/application.properties \
  --sub-path=application.properties
```

> S2I builder images use `/opt/app-root/src` as the working directory — this is where `app.js` runs from, so `dotenv` will find `application.properties` at that path.

To update the secret later (e.g. after changing `MONGO_URI`):
```bash
oc create secret generic api-test-config \
  --from-file=application.properties=./application.properties \
  --dry-run=client -o yaml | oc apply -f -

oc rollout restart deployment/api-test
```

---

## Step 5 — Expose the application

### HTTP route

```bash
oc expose service/api-test
oc get routes   # shows the assigned public URL
```

### HTTPS route (recommended)

OpenShift handles TLS termination at the router — no certificate management needed in the app:

```bash
oc create route edge api-test-tls --service=api-test --port=3000
```

---

## Step 6 — Deploy MongoDB inside OpenShift

If you do not have an external MongoDB instance, deploy one in the same project using S2I-compatible image deployment:

```bash
oc new-app \
  --image=mongo:4.4 \
  --name=mongodb \
  -e MONGO_INITDB_ROOT_USERNAME=root \
  -e MONGO_INITDB_ROOT_PASSWORD=example \
  -e MONGO_INITDB_DATABASE=api-test
```

Add a PersistentVolumeClaim so data survives pod restarts:

```bash
oc set volume deployment/mongodb \
  --add \
  --name=mongo-data \
  --type=pvc \
  --claim-size=5Gi \
  --mount-path=/data/db
```

Update `application.properties` locally to point at the in-cluster MongoDB service. Inside the same OpenShift project, the service name resolves as a DNS hostname:

```properties
MONGO_URI=mongodb://root:example@mongodb:27017/api-test?authSource=admin
```

Apply the updated secret and restart the app:

```bash
oc create secret generic api-test-config \
  --from-file=application.properties=./application.properties \
  --dry-run=client -o yaml | oc apply -f -

oc rollout restart deployment/api-test
```

---

## Step 7 — Add health probes

OpenShift uses liveness and readiness probes to manage pod health and restart unhealthy containers:

```bash
oc set probe deployment/api-test \
  --liveness --readiness \
  --get-url=http://:3000/ \
  --initial-delay-seconds=10 \
  --period-seconds=15
```

---

## Step 8 — Fix SSE timeout

OpenShift's HAProxy router has a default 30-second idle connection timeout. The SSE stream on `/api/curls/events` is a long-lived connection and will be cut without this annotation:

```bash
oc annotate route api-test \
  haproxy.router.openshift.io/timeout=600s

# Apply to the TLS route too if created
oc annotate route api-test-tls \
  haproxy.router.openshift.io/timeout=600s
```

---

## Triggering a new build after a code change

S2I build triggers can be configured to rebuild automatically on a Git push (via webhook) or manually:

### Manual rebuild

```bash
oc start-build api-test
oc logs -f buildconfig/api-test
```

### Webhook trigger (automatic rebuild on git push)

Get the webhook URL from OpenShift:

```bash
oc describe buildconfig/api-test | grep -A2 "Webhook"
```

Add the displayed URL as a webhook in your Git repository settings (GitHub: Settings → Webhooks → Add webhook). Every push to the configured branch will trigger a new S2I build and rolling deployment automatically.

---

## Verify the deployment

```bash
# Check pods are running
oc get pods

# Check the route URL
oc get routes

# Tail live application logs
oc logs -f deployment/api-test

# Check events if something is wrong
oc describe deployment/api-test

# Check build history
oc get builds
```

Open the app in a browser using the route URL shown by `oc get routes`.

---

## Important notes

### S2I working directory

The Node.js S2I builder places source code at `/opt/app-root/src` inside the container. The `application.properties` secret is mounted at that same path so `dotenv` finds it without any code changes.

### NPM install

S2I automatically runs `npm install` (or `npm ci` if a `package-lock.json` is present) during the build phase. No manual dependency installation is needed.

### Non-root container

OpenShift runs containers as a random non-root UID by default. The Node.js S2I builder is designed for this and handles permissions correctly. Port 3000 is a non-privileged port — no changes needed.

`server.log` is written to `/opt/app-root/src/server.log` inside the container. Logs are ephemeral unless a PVC is mounted at that path. The console output (which includes all log lines) is always available via `oc logs`.

### Scaling

```bash
oc scale deployment/api-test --replicas=2
```

> With multiple replicas, SSE clients connect to different pods. Each pod maintains its own in-memory check state and SSE client set. For multi-replica SSE consistency, a pub/sub layer (e.g. Redis) would be needed between pods.

### Updating configuration

1. Edit `application.properties` locally
2. Re-apply the secret: `oc create secret generic api-test-config --from-file=application.properties=./application.properties --dry-run=client -o yaml | oc apply -f -`
3. Restart the deployment: `oc rollout restart deployment/api-test`

---

*eat, sleep, automate — by eazyt*
