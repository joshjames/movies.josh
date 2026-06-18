#!/home/epic/.local/share/pipx/venvs/subliminal/bin/python
import os
import json
from pathlib import Path
import subliminal
from subliminal.video import Movie
from babelfish import Language

MOVIES_DIR = Path('~/movies').expanduser()
CONFIG_PATH = Path('~/.config/subliminal/subliminal.toml').expanduser()

def get_movie_metadata(folder_path):
    metadata_file = folder_path / 'metadata.json'
    if not metadata_file.exists():
        return None
    try:
        with open(metadata_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return {
            'title': data.get('title'),
            'year': int(data.get('year')) if data.get('year') else None
        }
    except Exception:
        return None

def process_library():
    print(f"🎬 Starting Cleaned Native Subliminal Pipeline Sweep...")
    
    # Configure the open providers using configuration file parameters
    # Disabling omdb if it gave you trouble previously, using opensubtitlescom natively
    providers = ['opensubtitlescom']
    languages = {Language.fromalpha2('en')}
    
    for folder in MOVIES_DIR.iterdir():
        if not folder.is_dir() or folder.name == "series":
            continue
            
        if list(folder.glob('*.srt')) + list(folder.glob('*.SRT')):
            continue
            
        video_extensions = ('.mp4', '.mkv', '.avi', '.m4v')
        videos = [f for f in folder.iterdir() if f.suffix.lower() in video_extensions]
        if not videos:
            continue
            
        meta = get_movie_metadata(folder)
        
        for video_path in videos:
            print(f"\nTargeting file: {video_path.name}")
            
            if meta and meta.get('title'):
                print(f"🎯 Injecting hard parameters ➡️ Name: {meta['title']} | Year: {meta['year']}")
                # We build a native Movie object so Subliminal can't misparse or drop tokens
                video = Movie(
                    name=str(video_path),
                    title=meta['title'],
                    year=meta['year']
                )
            else:
                # Fallback to standard automatic file guessing if JSON is missing
                video = subliminal.scan_video(str(video_path))
            
            try:
                # Force pool scoring via direct configuration mapping
                print("🔍 Querying providers natively...")
                subtitles = subliminal.download_best_subtitles(
                    [video], 
                    languages, 
                    providers=providers,
                    min_score=0 # Zero gate ensuring if it finds a match, it grabs it
                )
                
                if subtitles and video in subtitles:
                    subliminal.save_subtitles(video, subtitles[video])
                    print(f"   🎉 Subtitles successfully pulled down and saved!")
                else:
                    print(f"   ℹ️ Provider returned 0 valid matches for this payload configuration.")
                    
            except Exception as err:
                print(f"   ❌ Pipeline error: {err}")

if __name__ == "__main__":
    process_library()
