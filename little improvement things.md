little improvement things.


subtitles
   * the subtitle selector should not show the filename
    but just the language english



transcoding
   * live video transcoding HLS
   * audio language switcher.

   the audio switcher is apparently not possible from cloud storage. so we have to move to hls streaming..
   and perhaps audoio files are seperate. theres no reason we cant store the audio stream with the video stream if theres multiple
   i.e

   CLOUD / tt03828390 / 1080p.videostream.   AS-1.aac/mp3. AS-2.aac/mp3.   metadata.json.  
                         {
                            audiostreams:
                                "AS-1.aac":"English stream",
                                "AS-2.aac":"Audio Descriptrion"
                         }


ADMIN console/dashboard.
     - admin main lives in sydney.. with a node switcher...
