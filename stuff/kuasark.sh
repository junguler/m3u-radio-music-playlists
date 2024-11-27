#!/bin/bash

# get the list of all 7 different categories
curl -s https://kuasark.com/en/genres/ | htmlq -a href a | grep "/en/genres/" | grep -v 'page=' | sort | uniq | awk -F '/' '{print $4}' | awk NF > genres.txt
curl -s https://kuasark.com/en/languages/ | htmlq -a href a | grep '/en/languages/' | grep -v 'page=' | sort | uniq | awk -F '/' '{print $4}' | awk NF > languages.txt
curl -s https://kuasark.com/en/categories/ | htmlq -a href a | grep '/en/categories/' | grep -v 'page=' | sort | uniq | awk -F '/' '{print $4}' | awk NF > categories.txt
curl -s https://kuasark.com/en/countries/ | htmlq -a href a | grep "/en/countries/" | grep -v 'page=' | sort | uniq | awk -F '/' '{print $4}' | awk NF > countries.txt
curl -s https://kuasark.com/en/countries/ | htmlq -a href .l-links__box a | sort | awk -F '/' '{print $4}' > continents.txt
curl -s https://kuasark.com/en/regions/ | htmlq -a href a | grep '/en/regions/' | grep -v 'page=' | sort | uniq | awk -F '/' '{print $4}' | awk NF > regions.txt
curl -s https://kuasark.com/en/cities/ | htmlq -a href a | grep '/en/cities/' | grep -v 'page=' | sort | uniq | awk -F '/' '{print $4}' | awk NF > cities.txt

# extract the station names of everything
for i in "" \?page={2..50} ; do for j in $(cat genres.txt) ; do curl -s https://kuasark.com/en/genres/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..50} ; do for j in $(cat languages.txt) ; do curl -s https://kuasark.com/en/languages/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..50} ; do for j in $(cat categories.txt) ; do curl -s https://kuasark.com/en/categories/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..50} ; do for j in $(cat countries.txt) ; do curl -s https://kuasark.com/en/countries/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..50} ; do for j in $(cat continents.txt) ; do curl -s https://kuasark.com/en/continents/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..50} ; do for j in $(cat regions.txt) ; do curl -s https://kuasark.com/en/regions/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done
for i in "" \?page={2..50} ; do for j in $(cat cities.txt) ; do curl -s https://kuasark.com/en/cities/$j/$i | htmlq -a href .list-view a | grep stations | awk -F '/' '{print $4}' >> A-$j.txt ; echo "$j - $i" ; done ; done

# extract stream links and name
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://kuasark.com/en/stations/$j/ | grep -A1 'data-path=' | awk -F '"' '{print $2}' | tac | awk 'NR==1 {$0="#EXTINF:-1," $0} 1' | sed 's/\\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove streams that didn't have links - convert weird links to proper http
for i in AA-*.txt ; do cat $i | sed 's|/r|http:/|g' | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# convert links to m3u streams
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove AAA- and double extensions in streams
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done
