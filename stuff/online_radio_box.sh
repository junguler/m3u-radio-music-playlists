#!/bin/bash

# scrape the links from internet radio
#lynx --dump --listonly --nonumbers https://onlineradiobox.com/genres/ | grep "https://onlineradiobox.com/genre" | grep -v "genres" | sort | uniq > links.txt
curl -s https://onlineradiobox.com/genres/ | htmlq -a href a | grep "genre" | grep -v "genres" | sort | uniq | awk -F "/" '{print $3}' > genres.txt

# strip unnessery part of links (we'll add them later in the for loop) 
#cat links.txt | rev | cut -c2- | rev | cut -c34- > pages.txt

# scrape links of the streams
#for i in $(cat pages.txt) ; do for j in "" \?p={1..200} ; do curl https://onlineradiobox.com/genre/$i/$j | grep -oP 'stream="\K[^"]+' | grep -v "playerservices\|.m3u\|onlineradiobox" | sed 's/\;//g' | awk '!seen[$0]++' | sed '/^$/d' | awk 'length>10' >> $i.txt ; echo "$i - $j scraped" ; done ; done
for i in $(cat genres.txt) ; do curl -s https://onlineradiobox.com/genre/$i/ | htmlq .stations-list button '.station_play, .b-play' | grep -oP 'radioname="\K[^"]+|stream="\K[^"]+' | sed 's/\;//g' >> A-$i.txt ; echo -e "$i" ; done 
for i in $(cat genres.txt) ; do for j in \?p={1..200} ; do curl -s https://onlineradiobox.com/genre/$i/$j | htmlq .stations-list button '.station_play, .b-play' | grep -oP 'radioname="\K[^"]+|stream="\K[^"]+' | sed 's/\;//g' >> A-$i.txt ; echo -e "$i - $j" ; done ; done

# convert temp files to proper format
for i in A-*.txt ; do cat $i | awk '!seen[$0]++' | awk '{print "#EXTINF:-1 , "$0}' | sed 's/\;//g' | sed 's/#EXTINF:-1 , http/http/g' > A$i ; done

# convert files to m3u extension
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA and double extensions from files
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
