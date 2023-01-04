#!/bin/bash

# scrape the links from internet radio
lynx --dump --listonly --nonumbers https://www.internet-radio.com/stations/ | grep 'https://www.internet-radio.com/stations/' > links.txt

# strip unnessery part of links (we'll add them later in the for loop) 
cat links.txt | sed 's!https://www.internet-radio.com/stations/!!' | sed 's/\///g' | sed '/^$/d' | sed -e 's/ /%20/g' | sort | uniq > links2.txt

# scrape links of the streams
for i in "" page{2..16} ; do for j in $(cat links2.txt) ; do curl -s https://www.internet-radio.com/stations/$j/$i | htmlq --attribute href a | grep '.m3u' | cut -b 37- | awk -F '\\listen' '{print $1""}' | awk -F '\\.m3u' '{print $1""}' | awk -F '\\&t=' '{print $1""}' | awk '!seen[$0]++' | sed '/^$/d' | awk 'length>10' >> $j.txt ; echo "$j - $i scraped" ; done ; done

# a few links have more than 16 pages, the longest page is pop with 50 pages, so if you need all of them you have to run another for loop for them
# these streams need to be scraped for 34 pages or less furthur totaling of 50 pages = "Glam Rock" "Rock" "Classic" "Rock" "Pop"
# for i in page{17..50} ; do for j in "classic%20rock" "glam%20rock" "pop" "rock" ; do curl -s https://www.internet-radio.com/stations/$j/$i.html | htmlq --attribute href a | grep '.m3u' | cut -b 37- | awk -F '\\listen' '{print $1""}' | awk -F '\\.m3u' '{print $1""}' | awk -F '\\&t=' '{print $1""}' | awk '!seen[$0]++' | sed '/^$/d' | awk 'length>10' >> $j.txt ; echo "$j - $i scraped" ; done ; done

# convert links to m3u stream files
for i in $(cat links2.txt) ; do sed "s/^/#EXTINF:-1\n/" $i.txt | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done

# replace %20 in filenames with underline
for i in *.m3u ; do mv -- "$i" "$(printf '%s\n' "$i" | sed 's/%20/_/')" ; done

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/internet-radio/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
