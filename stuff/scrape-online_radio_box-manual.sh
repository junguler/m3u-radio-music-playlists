#!/bin/bash

# scrape the links from internet radio
lynx --dump --listonly --nonumbers https://onlineradiobox.com/genres/ | grep "https://onlineradiobox.com/genre" | grep -v "genres" | grep -v "lgbt" | sort | uniq > links.txt

# strip unnessery part of links (we'll add them later in the for loop) 
cat links.txt | rev | cut -c2- | rev | cut -c34- > pages.txt

# scrape links of the streams
for i in $(cat pages.txt) ; do for j in "" \?p={1..200} ; do curl https://onlineradiobox.com/genre/$i/$j | grep -oP 'stream="\K[^"]+' | grep -v "playerservices\|.m3u\|onlineradiobox" | sed 's/\;//g' | awk '!seen[$0]++' | sed '/^$/d' | awk 'length>10' >> $i.txt ; echo "$i - $j scraped" ; done ; done

# convert links to m3u stream files
for i in $(cat pages.txt) ; do sed "s/^/#EXTINF:-1\n/" $i.txt | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/online_radio_box/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
