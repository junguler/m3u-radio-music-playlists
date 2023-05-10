#!/bin/bash

# scrape the links
curl https://www.radioguide.fm/genre | htmlq -a href a | grep "/search/index?genre=" | sort | uniq | cut -c21- > genres.txt

# get the links for the webpages
for i in "" \&page={2..15} ; do for j in $(cat genres.txt) ; do curl -s "https://www.radioguide.fm/search/index?genre=$j$i&limit=250" | htmlq -a href a | awk '!seen[$0]++' | grep "/internet-radio-" | cut -c2- | grep "/" | sed 's/\;//g' | sed '/^$/d' | cut -c16- >> A-$j.txt ; echo -e "$j - $i" ; done ; done

# create country files from the genre files
for i in A-*.txt ; do cat $i >> all.txt ; done
cat all.txt | awk '!seen[$0]++' > all2.txt
cat all2.txt | awk -F "/" '{print $1}' | sort | uniq > countries.txt
for i in $(cat countries.txt) ; do grep $i all2.txt >> A-$i.txt ; done

# scrape the links from each text file to a m3u output
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://www.radioguide.fm/internet-radio-$j > mep1 ; cat mep1 | htmlq -t h1 | awk '{print "#EXTINF:-1 , "$0}' >> A$i ; cat mep1 | grep "var stream" | awk -F "'" '{print $6}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# convert links to m3u streams
for i in AA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AA-//' -e 's/.txt//'`" ; done
