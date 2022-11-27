#!/bin/bash

# scrape the links from internet radio
lynx --dump --listonly --nonumbers https://www.internet-radio.com/stations/ | grep 'https://www.internet-radio.com/stations/' > links.txt

# strip unnessery part of links (we'll add them later in the for loop) 
cat links.txt | sed 's!https://www.internet-radio.com/stations/!!' | sed 's/\///g' | sed '/^$/d' | sort | uniq > links2.txt

# scrape links of the streams
for i in "" page{2..10} ; do for j in $(cat links2.txt) ; do curl https://www.internet-radio.com/stations/$j/$i.html | htmlq --attribute href a | grep '.m3u' | cut -b 37- | awk -F '\\listen' '{print $1""}' | awk -F '\\.m3u' '{print $1""}' | awk -F '\\&t=' '{print $1""}' | awk '!seen[$0]++' | sed '/^$/d' >> $j.txt ; sleep 1 ; done ; done

# a few links have more than 10 pages, the longest page is pop with 50 pages, so if you abseloutly need all of them you can do those with a longer loop
# here is the list of the bigger links = Country Talk 80s Oldies Dance Gospel Christian Rock Pop

# convert links to m3u stream files
for i in $(cat links2.txt) ; do sed "s/^/#EXTINF:-1\n/" $i.txt | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/internet-radio/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
