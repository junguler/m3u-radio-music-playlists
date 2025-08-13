#!/bin/bash

# get the site map xml and extract all sub xmls from it
curl -s https://appradiofm.com/sitemap.xml > sitemap.xml
for i in $(cat sitemap.xml | htmlq loc -t) ; do curl -s $i > $(echo $i | awk -F '/' '{print $5}') ; done

# find all the radio links and insert them to a radio.txt file
for i in *.xml ; do cat $i | htmlq loc -t | grep '/radio/' | awk -F '/' '{print $NF}' >> radio.txt ; echo $i ; done

# scrape each radio page and insert genre, language and location tags into a big output.txt file
for i in $(cat radio.txt); do curl -s "https://appradiofm.com/radio/$i" > mep1; ( echo '#EXTINF:-1,'; ./htmlq h1 -t < mep1; ./htmlq '.details tr:nth-child(1) td:nth-child(2)' -t < mep1 | sed 's| |_|g; s/,/.||./g; 1s/^/|./;$s/$/.|/'; ./htmlq '.details tr:nth-child(2) td:nth-child(2)' -t < mep1 | sed 's| |_|g; s/,/-||-/g; 1s/^/|-/;$s/$/-|/'; ./htmlq '.details tr:nth-child(3) td:nth-child(2)' -t < mep1 | sed 's| |_|g; s/,/+||+/g; 1s/^/|+/;$s/$/+|/' ) | tr -d '\n' >> output.txt; printf '\n' >> output.txt; grep -Po '"stream_link": *\K"[^"]*"' mep1 | tail -n 1 | sed 's/"//g; s/;//g' | sed '/^$/d' >> output.txt; echo "$i"; done

# use the output.txt to create, genres, languages, countries playlists and insert them to their own folders (thanks lmarena.ai and chat-gpt 5 for the assist)
mkdir -p genres languages locations; awk 'function sanitize_tag(s){ sub(/^[[:space:]]+/,"",s); sub(/[[:space:]]+$/,"",s); gsub(/[\\\/:*?"<>|]/,"_",s); gsub(/[^ -~]/,"_",s); sub(/[. ]+$/,"",s); gsub(/_+/,"_",s); return s } function out(dir,tag,t,u,ft,f){ if(tag~/[[:alnum:]]/){ ft=sanitize_tag(tag); if(ft!=""){ f=dir "/" ft ".m3u"; print "#EXTINF:-1," t >> f; print u >> f; close(f) } } } /^#EXTINF:-1,/ { info=$0; sub(/\r?$/,"",info); sub(/^#EXTINF:-1,/,"",info); title=info; sub(/\|.*/,"",title); getline url; sub(/\r$/,"",url); s=info; while (match(s,/\|\.[^|]+\.\|/)) { out("genres",   substr(s,RSTART+2,RLENGTH-4), title, url); s=substr(s,RSTART+RLENGTH) } s=info; while (match(s,/\|\-[^|]+\-\|/)) { out("languages",substr(s,RSTART+2,RLENGTH-4), title, url); s=substr(s,RSTART+RLENGTH) } s=info; while (match(s,/\|\+[^|]+\+\|/)) { out("locations",substr(s,RSTART+2,RLENGTH-4), title, url); s=substr(s,RSTART+RLENGTH) } }' output.txt

# make folder names with the first character in each playlist to make using them locally and in github easier
for i in *.m3u ; do dir=$(echo $i | cut -c 1 -) ; mkdir -p $dir ; mv $i $dir ; done

# make the .m3u files proper by adding the header to them
find . -type f -name "*.m3u" -exec sed -i '1s/^/#EXTM3U\n/' {} \;