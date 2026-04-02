# How to Run MiniRAFT

This document provides complete, step-by-step instructions on how to run, test, and monitor the MiniRAFT Distributed Drawing Board natively on your local machine using Docker. 

## Prerequisites
- **Docker** and **Docker Compose** installed on your machine.
- A terminal (e.g., Terminal on macOS/Linux, or PowerShell/WSL on Windows).
- A web browser (e.g., Chrome, Firefox, Safari).

---

## 1. Starting the Application
The entire application runs inside Docker. Docker Compose handles starting the replicas, the gateway, the frontend, and the dashboard together in a single shared network.

1. Open your terminal.
2. Navigate to the project directory:
   ```bash
   cd /Users/sanidhyakumar/Downloads/miniraft
   ```
3. Start the cluster by running:
   ```bash
   docker compose up --build
   ```
   *(Note: You can also run it in detached mode in the background by appending `-d`, e.g., `docker compose up --build -d`)*

Once you see logs indicating that the replicas are receiving heartbeats, participating in leader elections, and the gateway is ready, the system is fully operational.

---

## 2. Accessing the User Interfaces
You don't need 4 people to run it! Just use your browser to act as multiple clients.

### The Drawing Board (Frontend)
- **URL**: [http://localhost:8080](http://localhost:8080)
- **How to Use**: Open this URL. You will see a drawing canvas. Draw anything!
- **How to Test Real-time Sync**: Open **multiple tabs** or completely different browsers (e.g., Chrome and Firefox) and go to `http://localhost:8080`. Draw in one window, and you will see the strokes appear instantly in the other windows through the distributed backend.

### The Operations Dashboard
- **URL**: [http://localhost:8090](http://localhost:8090)
- **How to Use**: This dashboard allows you to visually monitor which replica is the current leader, the term numbers, and verify that your system is working correctly.

---

## 3. Testing Real-World Scenarios (Failover)
This project is designed to survive crashes without dropping connections! You can test the failover mechanism manually:

1. Open the drawing board and start drawing.
2. Open a new terminal tab.
3. Find out which replica is the leader (you can see this in the dashboard at localhost:8090, or by running `./scripts/monitor_realtime.sh`).
4. Stop the leader container using Docker to simulate a server crash:
   ```bash
   docker stop replica1 
   ```
   *(Replace `replica1` with whichever replica is currently the leader).*
5. Check your drawing board! The gateway will automatically hold your connection, the remaining replicas will hold a new election, pick a new leader, and you can seamlessly continue drawing with **zero downtime**.

---

## 4. Using the Included Scripts
The project comes with a set of bash scripts to test and monitor your cluster:

### Monitoring the Cluster Status
To see a real-time terminal output of your cluster's health, use the `monitor_realtime.sh` script:
```bash
./scripts/monitor_realtime.sh
```
This will continuously output:
- The current Gateway Leader
- The total committed entries
- The specific status, term, and commit index of each replica container.

### Synthetic Load Test
Need to ensure traffic works without manually clicking the canvas? The `synthetic_commit_test.sh` script will create fake traffic to simulate a user drawing:
```bash
# Usage: ./scripts/synthetic_commit_test.sh [strokes_count] [delay_ms]
./scripts/synthetic_commit_test.sh 15 100
```
This simulates 15 drawing strokes with 100ms apart and verifies that the backend commit pipeline advances.

---

## 5. Stopping the Application
To stop all the servers and clean up the containers:
1. Go back to the terminal where you ran `docker compose`.
2. Press `Ctrl + C` to gracefully stop the containers.
3. To fully remove the containers, type:
   ```bash
   docker compose down
   ```
