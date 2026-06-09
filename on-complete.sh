#!/bin/bash

# Define log output file path
LOG_FILE="/home/epic/movie-streamer/automation.log"

echo "==================================================" >> $LOG_FILE
echo "⏰ Trigger activated on: $(date)" >> $LOG_FILE
echo "==================================================" >> $LOG_FILE

# 1. Run the Sanitizer (Scrapes OMDb, cleans directory, drops junk text)
echo "🎬 Running Library Sanitizer..." >> $LOG_FILE
/usr/bin/node /home/epic/movie-streamer/library-sanitizer.js >> $LOG_FILE 2>&1

# 2. Run the Pre-Transcoder (Finds raw files, converts to instant web-streaming MP4)
echo "⏳ Running Web-Optimization Pre-Transcoder..." >> $LOG_FILE
/usr/bin/node /home/epic/movie-streamer/pre-transcode.js >> $LOG_FILE 2>&1

echo "🏁 Automation cycle completed successfully." >> $LOG_FILE
echo -e "\n" >> $LOG_FILE