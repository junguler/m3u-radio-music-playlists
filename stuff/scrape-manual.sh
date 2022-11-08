#!/bin/bash

# scrape the links from radio pervii
lynx --dump --listonly --nonumbers http://radio.pervii.com/ | grep "http://radio.pervii.com/en/" > links.txt

# strip unnessery part of links (we'll add them later in the for loop) 
cat links.txt | sed 's!http://radio.pervii.com/en/!!' | sed 's!.htm!!' | sed '/^$/d' | grep -v "Various/\|radio/\|online-playlists-m3u\|live_now\|stations" > links2.txt

# scrape links of the streams
for i in "" "/2" "/3" "/4" "/5" "/6" "/7" ; do for j in $(cat links2.txt) ; do curl http://radio.pervii.com/en$i/$j.htm | grep "play_click" | awk -v FS="(\"|\")" '{print $2}' | sed 's/\;//g' | sed '/^$/d' >> $j.txt ; sleep 0.5 ; done ; done

# convert links to m3u stream files
for i in $(cat links2.txt) ; do sed "s/^/#EXTINF:-1\n/" $i.txt | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/manually_scraped/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
