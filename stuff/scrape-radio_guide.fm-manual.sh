#!/bin/bash

# scrape the links
curl https://www.radioguide.fm/genre | htmlq -a href a | grep "/search/index?genre=" | sort | uniq | cut -c21- > genres.txt

# get the links for the webpages
for i in "" \&page={2..15} ; do for j in $(cat genres.txt) ; do curl -s "https://www.radioguide.fm/search/index?genre=$j$i&limit=250" | ./htmlq -a href a | awk '!seen[$0]++' | grep "/internet-radio-" | cut -c2- | grep "/" | sed 's/\;//g' | sed '/^$/d' >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# remove genres.txt
rm genres.txt 

# scrape the links from each text file to a m3u output
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.radioguide.fm/$j | grep "var stream" | cut -c52- | rev | cut -c5- | rev | sed 's/^[ \t]*//' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed "s/^/#EXTINF:-1\n/" $i | sed '1s/^/#EXTM3U\n/' > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done

# move stream to git folder
mv *.m3u c:/git/m3u-radio-music-playlists/radio_guide.fm/

# add, commit and push
git -C c:/git/m3u-radio-music-playlists/ add .
git -C c:/git/m3u-radio-music-playlists/ commit -m "`date +'%b/%d - %I:%M %p'`"
git -C c:/git/m3u-radio-music-playlists/ push
