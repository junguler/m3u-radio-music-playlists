#!/bin/bash

# get a list of genre, countries and languages
curl -s https://oiradio.co/ | htmlq -a href a | sort | uniq | grep 'genre' | grep 'oi' | awk -F '/' '{print $5}' | awk NF > genres.txt
curl -s https://oiradio.co/ | htmlq -a href a | sort | uniq | grep 'lang' | awk -F '/' '{print $2}' > languages.txt
curl -s https://oiradio.co/ | htmlq -a href a | sort | uniq | grep -v 'lang\|genre\|http\|#' > countries.txt

# scrape stream names from each page
for i in "" /{2..5} ; do for j in $(cat genres.txt) ; do curl -s https://oiradio.co/genre/$j$i | htmlq -a href .col-sm-8 a | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" /{2..5} ; do for j in $(cat languages.txt) ; do curl -s https://oiradio.co/lang/$j$i | htmlq -a href .col-sm-8 a | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" /{2..5} ; do for j in $(cat countries.txt) ; do curl -s https://oiradio.co/$j$i | htmlq -a href .col-sm-8 a | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://oiradio.co/$j > mep1 ; cat mep1 | htmlq h1 -t | sed -e 's|Listen To ||g' -e 's| Live Station||g' | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | grep '<source class="source"' | head -n 1 | awk -F '"' '{print $4}' | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
