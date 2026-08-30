#!/usr/bin/env python3

import os
import time
import json

# Path to your configuration file
CONFIG_FILE = "/opt/gardenpi/config/garden.json"

def cleanup_old_logs():
    # 1. Load and parse the JSON configuration
    if not os.path.exists(CONFIG_FILE):
        print(f"Error: Configuration file '{CONFIG_FILE}' not found.")
        return
        
    with open(CONFIG_FILE, 'r') as f:
        try:
            config = json.load(f)
            # Extract the directory path using the nested JSON keys
            log_dir = config["webui"]["log_dir"]
        except (json.JSONDecodeError, KeyError) as e:
            print(f"Error parsing JSON or missing keys: {e}")
            return

    # 2. Check if the target directory exists
    if not os.path.isdir(log_dir):
        print(f"Directory does not exist: {log_dir}")
        return

    # 3. Calculate the threshold timestamp (7 days ago in seconds)
    seconds_in_day = 86400
    cutoff_time = time.time() - (7 * seconds_in_day)
    print(f"Scanning for files in '{log_dir}' older than 7 days...")

    # 4. Iterate through files and remove them
    # os.scandir is faster and more efficient than os.listdir for file attributes
    with os.scandir(log_dir) as entries:
        for entry in entries:
            # Only target files, ignore directories
            if entry.is_file():
                try:
                    # Get file metadata
                    file_stat = entry.stat()
                    # Use last modification time (.st_mtime)
                    if file_stat.st_mtime < cutoff_time:
                        print(f"Deleting: {entry.name} (Modified: {time.ctime(file_stat.st_mtime)})")
                        os.remove(entry.path)
                except Exception as e:
                    print(f"Failed to process or delete {entry.name}: {e}")

if __name__ == "__main__":
    cleanup_old_logs()

